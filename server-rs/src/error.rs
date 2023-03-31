use thiserror::Error;

#[derive(Error, Debug)]
pub enum SnapdropError {
    #[error("client has no user agent")]
    ClientNoUserAgent,
}
