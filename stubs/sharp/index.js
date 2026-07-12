// Stub for `sharp` — slopweaver only does TEXT embeddings, never image pipelines, but
// @xenova/transformers hard-depends on sharp and imports it eagerly (utils/image.js). The real sharp is
// a native dep whose binary breaks cross-platform installs. This no-op keeps the import working; it
// throws only if an image pipeline is actually used (never, here).
export default function sharp() {
  throw new Error('sharp is stubbed in slopweaver: image pipelines are not supported (text embeddings only)')
}
