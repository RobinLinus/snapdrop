use crate::protocol::Name;
use std::collections::HashSet;

const COLORS: [&str; 12] = [
    "Blue", "Green", "Red", "Orange", "Purple", "Pink", "Yellow", "Teal", "Navy", "Silver", "Gold",
    "Coral",
];

pub fn display_name(id: &str, label: &str, used: &HashSet<String>) -> String {
    // Preserve the existing browser identity's color across the migration.
    let hash = id
        .encode_utf16()
        .fold(0u32, |hash, c| hash.wrapping_mul(31).wrapping_add(c.into()));
    let start = hash as usize % COLORS.len();
    for number in 1.. {
        for offset in 0..COLORS.len() {
            let suffix = if number == 1 {
                String::new()
            } else {
                format!(" {number}")
            };
            let name = format!(
                "{} {label}{suffix}",
                COLORS[(start + offset) % COLORS.len()]
            );
            if !used.contains(&name) {
                return name;
            }
        }
    }
    unreachable!()
}

pub fn device(ua: &str) -> (Name, &'static str) {
    // Only classify the label and icon actually used by the UI. No regex database
    // or expensive model detection on the connection path.
    let (label, kind, _os) = if ua.contains("iPhone") {
        ("iPhone", "mobile", "iOS")
    } else if ua.contains("iPad") {
        ("iPad", "tablet", "iOS")
    } else if ua.contains("iPod") {
        ("iPod", "mobile", "iOS")
    } else if ua.contains("Windows Phone") {
        ("Windows Phone", "mobile", "Windows Phone")
    } else if ua.contains("SmartTV") || ua.contains("SMART-TV") || ua.contains("HbbTV") {
        ("TV", "smarttv", "")
    } else if ua.contains("PlayStation") || ua.contains("Xbox") {
        ("Console", "console", "")
    } else if ua.contains("Android") && ua.contains("Mobile") {
        ("Android Phone", "mobile", "Android")
    } else if ua.contains("Android") {
        ("Android Tablet", "tablet", "Android")
    } else if ua.contains("Macintosh") || ua.contains("Mac OS") {
        ("Mac", "", "Mac OS")
    } else if ua.contains("Windows") {
        ("Windows PC", "", "Windows")
    } else if ua.contains("CrOS") {
        ("Chromebook", "", "Chrome OS")
    } else if ua.contains("Linux") || ua.contains("Ubuntu") {
        ("Linux PC", "", "Linux")
    } else {
        ("Device", "", "")
    };
    let browser = if ua.contains("Edg/") {
        "Edge"
    } else if ua.contains("Firefox/") || ua.contains("FxiOS/") {
        "Firefox"
    } else if ua.contains("Chrome/") || ua.contains("CriOS/") {
        "Chrome"
    } else if ua.contains("Safari/") {
        "Safari"
    } else {
        ""
    };
    (
        Name {
            kind: kind.into(),
            device_name: format!("{label} {browser}").trim().into(),
            display_name: String::new(),
        },
        label,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_are_stable_unique_and_reusable() {
        let mut used = HashSet::new();
        let first = display_name("Aa", "Mac", &used);
        assert_eq!(first, display_name("BB", "Mac", &used));
        for _ in 0..200 {
            assert!(used.insert(display_name("Aa", "Mac", &used)));
        }
        used.remove(&first);
        assert_eq!(first, display_name("Aa", "Mac", &used));
    }
    #[test]
    fn recognizable_devices_and_icons() {
        for (ua, label, icon) in [
            ("iPhone", "iPhone", "mobile"),
            ("iPad", "iPad", "tablet"),
            ("Android Mobile", "Android Phone", "mobile"),
            ("Android", "Android Tablet", "tablet"),
            ("Macintosh", "Mac", ""),
            ("Windows NT", "Windows PC", ""),
            ("CrOS", "Chromebook", ""),
            ("Linux", "Linux PC", ""),
            ("", "Device", ""),
        ] {
            let (name, actual) = device(ua);
            assert_eq!(actual, label);
            assert_eq!(name.kind, icon);
        }
    }
}
