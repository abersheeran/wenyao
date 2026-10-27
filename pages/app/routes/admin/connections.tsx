import { ConnectionsPanel } from "../../components/admin/connections/connections-panel";
import { useAdminApi } from "~/apis";

export default function Connections() {
  const api = useAdminApi();
  return <ConnectionsPanel api={api} />;
}
