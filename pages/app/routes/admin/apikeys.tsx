import { ApiKeysPanel } from "../../components/admin/api-keys/api-keys-panel";
import { useAdminApi } from "~/apis";

export default function ApiKeys() {
  const api = useAdminApi();
  return <ApiKeysPanel api={api} />;
}
