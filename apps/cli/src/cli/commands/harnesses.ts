import { HARNESS_REGISTRY } from "../../harnesses/registry.ts";

export function printHarnesses(): void {
  for (const registration of HARNESS_REGISTRY) {
    console.log(registration.id);
  }
}
