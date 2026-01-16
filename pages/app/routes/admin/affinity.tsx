import { AffinityPanel } from "../../components/admin/affinity/affinity-panel";
import { useAdminApi } from "~/apis";

export default function Affinity() {
  const api = useAdminApi();
  return <AffinityPanel api={api} />;
}
