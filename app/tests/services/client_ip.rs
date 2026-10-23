use std::net::IpAddr;

use app::services::client_ip::{self, ProxyNetwork};

fn ip(value: &str) -> IpAddr {
  value.parse().unwrap()
}

fn proxies(values: &[&str]) -> Vec<ProxyNetwork> {
  values.iter().map(|value| value.parse().unwrap()).collect()
}

#[test]
fn an_untrusted_peer_is_the_client_even_when_it_sends_forwarded_for() {
  let trusted = proxies(&["10.0.0.0/8"]);
  assert_eq!(
    client_ip::resolve(Some(ip("203.0.113.7")), "198.51.100.1", &trusted),
    Some(ip("203.0.113.7"))
  );
  // Without trusted proxies the header is never read.
  assert_eq!(
    client_ip::resolve(Some(ip("127.0.0.1")), "198.51.100.1", &[]),
    Some(ip("127.0.0.1"))
  );
}

#[test]
fn a_trusted_proxy_reports_the_nearest_untrusted_hop() {
  let trusted = proxies(&["10.0.0.0/8", "127.0.0.1"]);
  // A client-supplied first entry cannot win: the chain is read from the
  // right and stops at the first address that is not a trusted proxy.
  assert_eq!(
    client_ip::resolve(
      Some(ip("127.0.0.1")),
      "1.1.1.1, 203.0.113.7, 10.0.0.5",
      &trusted
    ),
    Some(ip("203.0.113.7"))
  );
  // Proxies that write a port or a bracketed IPv6 address still resolve.
  assert_eq!(
    client_ip::resolve(Some(ip("10.0.0.2")), "203.0.113.7:51000", &trusted),
    Some(ip("203.0.113.7"))
  );
  assert_eq!(
    client_ip::resolve(Some(ip("10.0.0.2")), "[2001:db8::1]:443", &trusted),
    Some(ip("2001:db8::1"))
  );
}

#[test]
fn a_trusted_proxy_without_a_usable_header_is_the_client() {
  let trusted = proxies(&["10.0.0.0/8"]);
  assert_eq!(
    client_ip::resolve(Some(ip("10.0.0.2")), "", &trusted),
    Some(ip("10.0.0.2"))
  );
  // A malformed entry stops the walk at the last trusted hop.
  assert_eq!(
    client_ip::resolve(Some(ip("10.0.0.2")), "not-an-ip", &trusted),
    Some(ip("10.0.0.2"))
  );
  assert_eq!(client_ip::resolve(None, "203.0.113.7", &trusted), None);
}

#[test]
fn networks_match_ipv4_ipv6_and_mapped_addresses() {
  let network: ProxyNetwork = "172.16.0.0/12".parse().unwrap();
  assert!(network.contains(ip("172.31.255.1")));
  assert!(!network.contains(ip("172.32.0.1")));
  assert!(network.contains(ip("::ffff:172.16.0.9")));
  let v6: ProxyNetwork = "fd00::/8".parse().unwrap();
  assert!(v6.contains(ip("fd12::1")));
  assert!(!v6.contains(ip("fe80::1")));
  for invalid in ["10.0.0.0/33", "fd00::/129", "proxy", "10.0.0.0/x"] {
    assert!(
      invalid.parse::<ProxyNetwork>().is_err(),
      "accepted {invalid}"
    );
  }
  assert!(client_ip::parse_list(" , ").is_err());
}
