# RC2.2.1 release checklist

## Configuration review

- [x] Change the three requested DoH groups to `dns.alidns.com` and `doh.pub`; keep bootstrap IP resolvers.
- [x] Confirm `ipv6: true`, `dns.ipv6: true` and `fake-ip-range6`.
- [x] Confirm `ChinaIpv6` is placed before the final catch-all rule and targets `DIRECT`.
- [x] Confirm there is no dedicated IPv6 proxy group or forced alternate node.
- [x] Confirm “其他 - 手动选择” is defined once, excludes the five named regions, and is referenced by the five intended application groups.
- [x] Confirm the template contains no personal subscription, node, hostname, IP, UUID, password, private key or user-specific controller secret.
- [x] Keep only `__SUBSCRIPTION_URL__` as a pending local setup marker; never publish a personal subscription URL.
- [x] Set the clean-install template to `0.0.0.0:9099` and document the requested public default secret risk without changing upgraded configurations.
- [x] Reject inline proxy nodes, node credential fields, proxy share links, extra controller secrets and credential-bearing URLs during release construction.

## Runtime provenance

- [x] Pin the official Android arm64 Mihomo `v1.19.31` release.
- [x] Record its upstream URL, version, compressed checksum and decompressed checksum outside the binary.
- [x] Put the verified ELF64 AArch64 executable at `runtime/mihomo` only for release construction.
- [x] Include the upstream GPL-3.0 license and corresponding-source link with the runtime payload.
- [x] Pin and validate the exact `v1.19.31` source archive as a separate release companion asset.
- [ ] Review optional UI, Geo data and provider seed sources.

## Installer verification

- [x] Run local front-end config-edit tests for CRLF template, legacy port migration, and main provider node count.
- [x] Run local device-side release-fetch tests for three direct attempts, optional proxy fallback, command length and cleanup; use the device-tested RC2.2 hotfix as the RC2.2.1 front-end basis.
- [ ] Test a clean F50 installation with no `/data/f50-mihomo` directory: backend installed, configured=0, core stopped, no TProxy or boot entry.
- [ ] Fill the HTTPS subscription in the front end: config validates, core starts, dual-stack health passes, configured=1, boot entry enabled.
- [ ] Verify the subscription dialog keeps progress visible and reports the `main` provider node count without exposing node names or credentials.
- [ ] Verify zero nodes, an unreachable controller, and a failed config apply show distinct persistent warnings.
- [ ] Confirm clean install binds the Mihomo API and MetaCubeXD at 9099, not another process on that port.
- [ ] Upgrade an existing 9090 installation without changing config, then explicitly migrate to 9099; verify backup, API, XD and rollback on failure.
- [ ] Upgrade an RC2.1 backend that still has `setup-pending`: preserve its config and stopped state, then fill the subscription and confirm the legacy default port becomes 9099.
- [ ] Compare the MetaCubeXD row with UFI-Tools native `title`/`btn` styling on the device.
- [ ] Test failed first subscription: pending config remains, no boot entry is added, and retry succeeds.
- [ ] Test RC1/RC2/RC2.1 to RC2.2.1 upgrade with a non-9099 controller port; verify `config.yaml` SHA-256 and bytes are unchanged before the explicit migration action.
- [ ] Test `rollback-last.sh` restores the pre-upgrade scripts while leaving `config.yaml` SHA-256 and bytes unchanged.
- [ ] Test destructive uninstall removes the process, IPv4/IPv6 rules, boot entry, `/data/f50-mihomo`, failed/staging leftovers and boot log.
- [ ] Confirm uninstall does not remove the UFI-Tools front-end registration or files under `/sdcard/Download`.
- [ ] Test invalid CLI `--config`: the formal directory must remain untouched.
- [ ] Test corrupted release package: checksum must fail before extraction.
- [ ] After publication, test device-side GitHub download and checksum; verify local package fallback when the device cannot reach GitHub.
- [ ] Test failed first start with CLI subscription: firewall rules are removed and failure state is preserved.
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
- [x] Pin `OWNER/REPOSITORY` to `Kiro-Durandal/MihomoForUFI` and the proposed release tag to `v2.6-rc2.2.1`.
- [ ] Confirm the repository, immutable `v2.6-rc2.2.1` tag and Release are anonymously readable after publication.
- [x] Locally build the `.tar`, then verify its byte size and SHA-256 against the manifest; device verification is still pending.
- [x] Add a release workflow that pins upstream downloads and refuses an existing RC2.2.1 tag.
- [x] Confirm the build script set `INSTALL_MANIFEST_URL` to the intended immutable raw manifest URL.
- [x] Re-run source and artifact credential scans; the template contains only the public placeholder and documented initial controller secret.
- [x] Review the exact Git tree before push; retain old versioned JS/workflows for prior releases and add the RC2.2.1 files.
- [ ] Publish the JS, manifest, installer `.tar`, `mihomo-v1.19.31-source.tar.gz` and `SHA256SUMS.release.txt` as the same release version.
