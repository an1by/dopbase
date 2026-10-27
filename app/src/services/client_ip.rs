//! The client address audit records store.
//!
//! The connection's peer address is the client unless the peer is a
//! configured trusted proxy. Only then is `X-Forwarded-For` read, from the
//! right, skipping every trusted hop, so a client cannot choose the address
//! written to the audit log by sending the header itself.

use std::{
  fmt,
  future::Future,
  net::{IpAddr, Ipv6Addr},
  str::FromStr,
};

use anyhow::{Context, bail};

/// One trusted proxy: a single address or a CIDR network.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProxyNetwork {
  network: IpAddr,
  prefix: u8,
}

impl ProxyNetwork {
  pub fn contains(
    &self,
    address: IpAddr,
  ) -> bool {
    match (self.network, canonical(address)) {
      (IpAddr::V4(network), IpAddr::V4(address)) => {
        masked(u32::from(network).into(), self.prefix, 32)
          == masked(u32::from(address).into(), self.prefix, 32)
      }
      (IpAddr::V6(network), IpAddr::V6(address)) => {
        masked(u128::from(network), self.prefix, 128)
          == masked(u128::from(address), self.prefix, 128)
      }
      _ => false,
    }
  }
}

impl FromStr for ProxyNetwork {
  type Err = anyhow::Error;

  fn from_str(value: &str) -> Result<Self, Self::Err> {
    let value = value.trim();
    let (address, prefix) = match value.split_once('/') {
      Some((address, prefix)) => (address, Some(prefix)),
      None => (value, None),
    };
    let network = canonical(
      address
        .parse::<IpAddr>()
        .with_context(|| format!("invalid trusted proxy address `{value}`"))?,
    );
    let width = if network.is_ipv4() { 32 } else { 128 };
    let prefix = match prefix {
      Some(prefix) => prefix
        .parse::<u8>()
        .ok()
        .filter(|prefix| *prefix <= width)
        .with_context(|| format!("invalid trusted proxy prefix in `{value}`"))?,
      None => width,
    };
    Ok(Self { network, prefix })
  }
}

impl fmt::Display for ProxyNetwork {
  fn fmt(
    &self,
    formatter: &mut fmt::Formatter<'_>,
  ) -> fmt::Result {
    write!(formatter, "{}/{}", self.network, self.prefix)
  }
}

/// Parse a comma-separated list of trusted proxies, as
/// `DOPBASE_TRUSTED_PROXIES` takes it.
pub fn parse_list(value: &str) -> anyhow::Result<Vec<ProxyNetwork>> {
  let networks = value
    .split(',')
    .filter(|entry| !entry.trim().is_empty())
    .map(ProxyNetwork::from_str)
    .collect::<anyhow::Result<Vec<_>>>()?;
  if networks.is_empty() && !value.trim().is_empty() {
    bail!("no trusted proxy addresses were given");
  }
  Ok(networks)
}

fn masked(
  value: u128,
  prefix: u8,
  width: u8,
) -> u128 {
  if prefix == 0 {
    return 0;
  }
  value >> (width - prefix)
}

/// IPv4 clients reached over an IPv6 socket arrive as `::ffff:a.b.c.d`.
fn canonical(address: IpAddr) -> IpAddr {
  match address {
    IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4),
    address => address,
  }
}

/// The client address for a request, given its peer address and its
/// `X-Forwarded-For` header (empty when the request has none).
pub fn resolve(
  peer: Option<IpAddr>,
  forwarded_for: &str,
  trusted: &[ProxyNetwork],
) -> Option<IpAddr> {
  let peer = canonical(peer?);
  let is_trusted = |address: IpAddr| trusted.iter().any(|network| network.contains(address));
  if !is_trusted(peer) {
    return Some(peer);
  }
  let mut client = peer;
  for hop in forwarded_for.rsplit(',') {
    // An entry that is not an address means the chain cannot be trusted
    // past this point, so the last trusted hop is the best answer.
    let Some(address) = parse_hop(hop) else {
      return Some(client);
    };
    client = address;
    if !is_trusted(address) {
      return Some(address);
    }
  }
  Some(client)
}

/// Proxies write either a bare address or one with a port.
fn parse_hop(hop: &str) -> Option<IpAddr> {
  let hop = hop.trim();
  if let Ok(address) = hop.parse::<IpAddr>() {
    return Some(canonical(address));
  }
  if let Ok(socket) = hop.parse::<std::net::SocketAddr>() {
    return Some(canonical(socket.ip()));
  }
  hop
    .strip_prefix('[')
    .and_then(|rest| rest.split_once(']'))
    .and_then(|(address, _)| address.parse::<Ipv6Addr>().ok())
    .map(|address| canonical(IpAddr::V6(address)))
}

tokio::task_local! {
  static CLIENT_IP: Option<IpAddr>;
}

/// Run a request with its client address available to [`current`].
pub async fn scope<F: Future>(
  address: Option<IpAddr>,
  request: F,
) -> F::Output {
  CLIENT_IP.scope(address, request).await
}

/// The client address of the request being handled, if any. Work that is
/// not part of a request, such as retention at startup, has none.
pub fn current() -> Option<IpAddr> {
  CLIENT_IP.try_with(|address| *address).ok().flatten()
}
