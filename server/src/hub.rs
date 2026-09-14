use crate::{
    names,
    protocol::{self, Message, Name, PeerInfo, Relay},
};
use axum::extract::ws::Message as Frame;
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

const QUEUE_BYTES: usize = 512 * 1024;
pub struct Outbound {
    pub frame: Frame,
    pub bytes: usize,
}

#[derive(Clone)]
pub struct Outbox {
    pub tx: mpsc::Sender<Outbound>,
    pub queued: Arc<AtomicUsize>,
    pub close: watch::Sender<bool>,
}
impl Outbox {
    pub fn send(&self, message: &Message) -> bool {
        if *self.close.borrow() {
            return false;
        }
        let data = match protocol::encode(message) {
            Ok(data) => data,
            Err(_) => {
                self.stop();
                return false;
            }
        };
        let bytes = data.len();
        if self.queued.fetch_add(bytes, Ordering::Relaxed) + bytes > QUEUE_BYTES {
            self.queued.fetch_sub(bytes, Ordering::Relaxed);
            self.stop();
            return false;
        }
        if self
            .tx
            .try_send(Outbound {
                frame: Frame::Binary(data.into()),
                bytes,
            })
            .is_err()
        {
            self.queued.fetch_sub(bytes, Ordering::Relaxed);
            self.stop();
            return false;
        }
        true
    }
    pub fn stop(&self) {
        let _ = self.close.send(true);
    }
}

pub struct Peer {
    pub id: Uuid,
    pub connection: Uuid,
    pub name: Name,
    pub rtc: bool,
    pub out: Outbox,
}
impl Peer {
    pub fn new(id: Uuid, rtc: bool, ua: &str, out: Outbox) -> (Self, &'static str) {
        let (name, label) = names::device(ua);
        (
            Self {
                id,
                connection: Uuid::new_v4(),
                name,
                rtc,
                out,
            },
            label,
        )
    }
    fn info(&self) -> PeerInfo {
        PeerInfo {
            id: self.id,
            connection: self.connection,
            display_name: self.name.display_name.clone(),
            icon: match self.name.kind.as_str() {
                "mobile" => 1,
                "tablet" => 2,
                _ => 0,
            },
            rtc: self.rtc,
        }
    }
}

#[derive(Default)]
pub struct Room {
    peers: HashMap<Uuid, Peer>,
    groups: HashMap<Uuid, Vec<Uuid>>,
}
impl Room {
    fn info(&self, id: Uuid) -> Option<PeerInfo> {
        self.peers
            .get(self.groups.get(&id)?.last()?)
            .map(Peer::info)
    }
    fn join(&mut self, mut peer: Peer, label: &str, max_room: usize) -> Result<(), &'static str> {
        if self.peers.len() >= max_room {
            return Err("room full");
        }
        let existing = self.info(peer.id);
        if let Some(info) = &existing {
            if self.groups[&peer.id].len() >= 16 {
                return Err("too many tabs");
            }
            peer.name.display_name = info.display_name.clone();
        } else {
            let used = self
                .peers
                .values()
                .map(|p| p.name.display_name.clone())
                .collect();
            peer.name.display_name = names::display_name(&peer.id.to_string(), label, &used);
        }
        let id = peer.id;
        peer.out.send(&Message::Identity(
            id,
            peer.connection,
            peer.name.display_name.clone(),
            peer.name.device_name.clone(),
        ));
        let snapshot = self
            .groups
            .keys()
            .filter(|other| **other != id)
            .filter_map(|other| self.info(*other))
            .collect();
        peer.out.send(&Message::Peers(snapshot));
        self.groups.entry(id).or_default().push(peer.connection);
        let info = peer.info();
        self.peers.insert(peer.connection, peer);
        if existing.is_none() {
            self.broadcast_except(id, &Message::Joined(info));
        } else {
            self.broadcast_except(id, &Message::Updated(info, None));
        }
        Ok(())
    }
    fn broadcast_except(&self, excluded: Uuid, message: &Message) {
        for peer in self.peers.values().filter(|p| p.id != excluded) {
            peer.out.send(message);
        }
    }
    pub fn relay(&self, from: Uuid, relay: Relay) {
        let Some(sender) = self.peers.get(&from) else {
            return;
        };
        // Destinations are connection IDs, not visible device IDs. Replies and
        // in-flight traffic never silently move to another tab.
        let Some(recipient) = self.peers.get(&relay.recipient) else {
            return;
        };
        if recipient.id == sender.id {
            return;
        }
        recipient
            .out
            .send(&Message::Relay(sender.id, from, relay.payload));
    }
    fn leave(&mut self, connection: Uuid) {
        let Some(peer) = self.peers.remove(&connection) else {
            return;
        };
        let group = self.groups.get_mut(&peer.id).unwrap();
        group.retain(|id| *id != connection);
        if group.is_empty() {
            self.groups.remove(&peer.id);
            self.broadcast_except(peer.id, &Message::Left(peer.id));
        } else if let Some(info) = self.info(peer.id) {
            self.broadcast_except(peer.id, &Message::Updated(info, Some(connection)));
        }
    }
}

#[derive(Default)]
pub struct Hub {
    rooms: Mutex<HashMap<IpAddr, Arc<Mutex<Room>>>>,
}
impl Hub {
    pub fn join(
        &self,
        ip: IpAddr,
        peer: Peer,
        label: &str,
        max_room: usize,
    ) -> Result<Arc<Mutex<Room>>, &'static str> {
        let mut rooms = self.rooms.lock().unwrap();
        let room = rooms.entry(ip).or_default().clone();
        room.lock().unwrap().join(peer, label, max_room)?;
        Ok(room)
    }
    pub fn leave(&self, ip: IpAddr, connection: Uuid) {
        let mut rooms = self.rooms.lock().unwrap();
        let empty = if let Some(room) = rooms.get(&ip) {
            let mut room = room.lock().unwrap();
            room.leave(connection);
            room.peers.is_empty()
        } else {
            false
        };
        if empty {
            rooms.remove(&ip);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn peer(id: Uuid) -> (Peer, mpsc::Receiver<Outbound>, watch::Receiver<bool>) {
        let (tx, rx) = mpsc::channel(32);
        let (close, closed) = watch::channel(false);
        let out = Outbox {
            tx,
            close,
            queued: Arc::new(AtomicUsize::new(0)),
        };
        (Peer::new(id, true, "Macintosh", out).0, rx, closed)
    }
    #[test]
    fn duplicate_tabs_do_not_remove_the_identity_or_retarget_traffic() {
        let mut room = Room::default();
        let id = Uuid::new_v4();
        let (a, _ra, _ca) = peer(id);
        let a_conn = a.connection;
        let (b, mut rb, _cb) = peer(id);
        let b_conn = b.connection;
        let (sender, _rs, _cs) = peer(Uuid::new_v4());
        let from = sender.connection;
        room.join(a, "Mac", 256).unwrap();
        room.join(b, "Mac", 256).unwrap();
        room.join(sender, "Mac", 256).unwrap();
        room.leave(a_conn);
        while rb.try_recv().is_ok() {}
        assert_eq!(room.groups[&id], vec![b_conn]);
        room.relay(
            from,
            Relay {
                recipient: a_conn,
                payload: vec![1, 2, 3].into(),
            },
        );
        assert!(rb.try_recv().is_err());
        room.leave(a_conn);
        assert_eq!(room.groups[&id], vec![b_conn]);
    }
    #[test]
    fn queue_overflow_closes_only_the_slow_connection() {
        let (p, _rx, closed) = peer(Uuid::new_v4());
        for _ in 0..33 {
            p.out.send(&Message::Left(Uuid::new_v4()));
        }
        assert!(*closed.borrow());
        assert!(p.out.queued.load(Ordering::Relaxed) <= QUEUE_BYTES);
    }
}
