export const PRODUCT_IDENTITY = Object.freeze({
  applicationId: "axon",
  command: "axon",
  displayName: "Axon",
  homeEnvironmentVariable: "AXON_HOME",
  defaultHomeDirectoryName: ".axon",
});

export type ProductIdentity = typeof PRODUCT_IDENTITY;
