# Runtime payload

The local release workspace now contains the pinned Android arm64 runtime:

```text
runtime/mihomo
```

Its exact version, upstream URLs, compressed/decompressed SHA-256 values and
ELF architecture are recorded in `MIHOMO-PROVENANCE.md`. The upstream GPL-3.0
license is stored as `LICENSE.mihomo`. Both metadata files belong in source
control; the 64 MB executable remains Git-ignored. The local build process
verifies it, then places a gzip-compressed copy in the installer `.tar`. The
installer expands it back to the verified executable before running it.

`mihomo-v1.19.31-source.tar.gz` is the exact upstream tag archive. It is also
Git-ignored, verified by the build script, and copied to `dist/` as a separate
GitHub Release asset. It is deliberately not duplicated inside the installer
`.tar` package.

Optional seed assets may also be placed here:

```text
runtime/ui/
runtime/providers/
runtime/GeoIP.dat
runtime/GeoSite.dat
runtime/country.mmdb
runtime/geoip.metadb
```

Do not copy a personal `config.yaml`, provider cache, logs, cache database or
subscription response into this directory. The release archive SHA-256 and
byte size must be written to `release-manifest.json` after the archive is built.

