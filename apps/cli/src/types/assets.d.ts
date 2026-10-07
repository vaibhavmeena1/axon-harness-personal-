declare module "*.mjs" {
  const assetPath: string;
  export default assetPath;
}

// Bun's file loader returns an asset path, not the standalone extension's exports.
declare module "*harnesses/pi/resources/extensions/web-search.ts" {
  const assetPath: string;
  export default assetPath;
}
