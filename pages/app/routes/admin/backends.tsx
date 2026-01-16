import { BackendsPanel } from "../../components/admin/backends/backends-panel";
import { useAdminApi } from "~/apis";

export default function Backends() {
  const api = useAdminApi();
  return <BackendsPanel api={api} />;
}
