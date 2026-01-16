import { MetricsPanel } from "../../components/admin/stats/metrics-panel";
import { useAdminApi } from "~/apis";

export default function Metrics() {
  const api = useAdminApi();
  return <MetricsPanel api={api} />;
}
