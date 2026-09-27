# RC2 release checklist

## Configuration review

- [x] Review every DNS option and resolver URL against the supplied reference configuration.
- [x] Confirm `ipv6: true`, `dns.ipv6: true` and `fake-ip-range6`.
- [x] Confirm `ChinaIpv6` is placed before the final catch-all rule and targets `DIRECT`.
- [x] Confirm there is no dedicated IPv6 proxy group or forced alternate node.
- [x] Confirm “其他 - 手动选择” is defined once, excludes the five named regions, and is referenced by the five intended application groups.
- [x] Confirm the template contains no personal subscription, node, hostname, IP, UUID, password, private key or user-specific controller secret.
- [x] Keep only `__SUBSCRIPTION_URL__` as an installation-time private placeholder.
- [x] Set the clean-install template to `0.0.0.0:9090` and document the requested public default secret risk without changing upgraded configurations.
- [x] Reject inline proxy nodes, node credential fields, proxy share links, extra controller secrets and credential-bearing URLs during release construction.

## Runtime provenance

- [x] Pin the official Android arm64 Mihomo `v1.19.31` release.
- [x] Record its upstream URL, version, compressed checksum and decompressed checksum outside the binary.
- [x] Put the verified ELF64 AArch64 executable at `runtime/mihomo` only for release construction.
- [x] Include the upstream GPL-3.0 license and corresponding-source link with the runtime payload.
- [x] Pin and validate the exact `v1.19.31` source archive as a separate release companion asset.
- [ ] Review optional UI, Geo data and provider seed sources.

## Installer verification

- [ ] Test a clean F50 installation with no `/data/f50-mihomo` directory.
- [ ] Test RC1 to RC2 upgrade with a non-9090 controller port; verify `config.yaml` SHA-256 and bytes are unchanged and the front end/backend follow that port.
- [ ] Test `rollback-last.sh` restores the pre-upgrade scripts while leaving `config.yaml` SHA-256 and bytes unchanged.
- [ ] Test destructive uninstall removes the process, IPv4/IPv6 rules, boot entry, `/data/f50-mihomo`, failed/staging leftovers and boot log.
- [ ] Confirm uninstall does not remove the UFI-Tools front-end registration or files under `/sdcard/Download`.
- [ ] Test invalid config: the formal directory must remain untouched.
- [ ] Test corrupted release package: checksum must fail before extraction.
- [ ] Test failed first start: firewall rules are removed and failure state is preserved.
- [ ] Test reboot: IPv4 and IPv6 rules return automatically.
- [ ] Test installation without carrier IPv6: IPv4 must still start after boot timeout.

## Network behavior

- [ ] Domestic IPv4 is direct according to the reviewed rules.
- [ ] Domestic IPv6 is direct according to `ChinaIpv6`.
- [ ] Foreign IPv4 uses the selected normal policy.
- [ ] A dual-stack foreign site remains usable with an IPv4-only selected node.
- [ ] No automatic node switch occurs for foreign IPv6.
- [ ] Document that foreign IPv6-only targets may fail on IPv4-only nodes.

## Publication

- [x] Add the user-selected MIT license for original project files and document that it does not relicense Mihomo.
- [x] Pin `OWNER/REPOSITORY` to `Kiro-Durandal/MihomoForUFI` and the release tag to `v2.6-rc2`.
- [ ] Confirm the repository, immutable `v2.6-rc2` tag and Release are anonymously readable; the repository API returned 404 on 2026-09-27.
- [ ] Build the `.tar`, then generate its final byte size and SHA-256 manifest.
- [x] Add a manually triggered release workflow that pins upstream downloads and refuses an existing RC2 tag.
- [ ] Confirm the build script replaced `INSTALL_MANIFEST_URL` with the intended immutable raw manifest URL.
- [ ] Re-run source and artifact credential scans.
- [ ] Review `git diff` and the exact Git index before the first push.
- [ ] Publish the JS, manifest, installer `.tar`, `mihomo-v1.19.31-source.tar.gz` and `SHA256SUMS.release.txt` as the same release version.
