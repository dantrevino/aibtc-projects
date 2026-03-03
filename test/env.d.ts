import type { Env } from "../src/lib/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
