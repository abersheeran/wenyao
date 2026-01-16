import { StatsPanel } from "../../components/admin/stats/stats-panel";
import { useAdminApi } from "~/apis";

export default function Stats() {
  const api = useAdminApi();
  return <StatsPanel api={api} />;
}
