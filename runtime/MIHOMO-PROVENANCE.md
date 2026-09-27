# Mihomo runtime provenance

The RC2 release payload is pinned to the following unmodified upstream binary.
The only transformation performed locally was gzip decompression and renaming
the resulting executable to `runtime/mihomo`.

- Project: MetaCubeX/mihomo
- Version/tag: `v1.19.31`
- Release: https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.31
- Corresponding source: https://github.com/MetaCubeX/mihomo/tree/v1.19.31
- Original asset: `mihomo-android-arm64-v8-v1.19.31.gz`
- Original asset URL: https://github.com/MetaCubeX/mihomo/releases/download/v1.19.31/mihomo-android-arm64-v8-v1.19.31.gz
- Original asset bytes: `21808349`
- Original asset SHA-256: `de00bc53ed151636ca078c812a82a5315687d8d52164db230f1935b2a37904f6`
- Decompressed `runtime/mihomo` bytes: `63866712`
- Decompressed `runtime/mihomo` SHA-256: `dbd8af275219a097d66362d543b32f65ba0d4de9d96a49bf5e9abdcdad3af6f1`
- Binary format: ELF64, little-endian, AArch64 (`e_machine=183`)
- Embedded version marker: `v1.19.31`
- Embedded Go marker: `go1.26.8`
- Verified on: `2026-09-27`

The RC2 release also publishes the exact upstream tag archive as a separate
companion asset rather than placing it inside the installer archive:

- Source asset: `mihomo-v1.19.31-source.tar.gz`
- Source asset bytes: `1263209`
- Source asset SHA-256: `5a04aa9cf4520e06fa1c13d37b6aca49209479690722d485c40034ab17f8581f`
- Archive root: `mihomo-1.19.31/`

Mihomo is distributed under GNU GPL version 3. The upstream license text is
included verbatim as `runtime/LICENSE.mihomo`. Keep the license and this
provenance file beside every release payload that contains the executable, and
keep the corresponding source archive available with that release.
