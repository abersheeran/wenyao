import type { D1Migration } from 'cloudflare:test'

declare global {
  namespace Cloudflare {
    interface Env {
      ADMIN_APIKEYS: string
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}
