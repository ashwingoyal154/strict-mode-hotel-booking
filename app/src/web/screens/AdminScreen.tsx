/**
 * Admin — seven quiet tabs over the entity's policy, exceptions, duty of care,
 * directory, FX pins, data rights and metrics. The selected tab lives in the URL
 * hash so a link to `/admin#fx` opens the FX pins.
 *
 * Each panel owns its own fetch and mounts only while selected, so opening Admin
 * costs one request, not seven.
 */

import { useLocation, useNavigate } from "react-router-dom";
import { ADMIN_CSV_HREF } from "../lib/api.ts";
import { DataRightsPanel } from "./admin/DataRightsPanel.tsx";
import { DirectoryPanel } from "./admin/DirectoryPanel.tsx";
import { ExceptionsPanel } from "./admin/ExceptionsPanel.tsx";
import { FxPanel } from "./admin/FxPanel.tsx";
import { InMarketPanel } from "./admin/InMarketPanel.tsx";
import { MetricsPanel } from "./admin/MetricsPanel.tsx";
import { PolicyPanel } from "./admin/PolicyPanel.tsx";
import { TabPanel, Tabs, type TabSpec } from "./admin/Tabs.tsx";
import "../design/admin.css";

type AdminTab = "policy" | "exceptions" | "in-market" | "directory" | "fx" | "data-rights" | "metrics";

const TABS: readonly TabSpec<AdminTab>[] = [
  { id: "policy", label: "Policy" },
  { id: "exceptions", label: "Exceptions" },
  { id: "in-market", label: "In market" },
  { id: "directory", label: "Directory" },
  { id: "fx", label: "FX pins" },
  { id: "data-rights", label: "Data rights" },
  { id: "metrics", label: "Metrics" },
];

const ID_BASE = "admin";

function tabFromHash(hash: string): AdminTab {
  const id = hash.replace(/^#/, "");
  return TABS.find((t) => t.id === id)?.id ?? "policy";
}

export function AdminScreen(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const selected = tabFromHash(location.hash);

  const select = (id: AdminTab): void => {
    if (id === selected) return;
    navigate({ pathname: location.pathname, search: location.search, hash: `#${id}` }, { replace: true });
  };

  return (
    <div className="admin2">
      <div className="admin2__head">
        <div className="screen__head">
          <h1 className="h1">Admin</h1>
          <p className="prose">
            The rules every verdict is produced by, the exceptions to them, and who is on the road tonight.
          </p>
        </div>
        <a className="btn-text" href={ADMIN_CSV_HREF} download>
          Download bookings.csv
        </a>
      </div>

      <Tabs tabs={TABS} selected={selected} onSelect={select} label="Admin sections" idBase={ID_BASE} />

      <TabPanel idBase={ID_BASE} id={selected}>
        {selected === "policy" ? <PolicyPanel /> : null}
        {selected === "exceptions" ? <ExceptionsPanel /> : null}
        {selected === "in-market" ? <InMarketPanel /> : null}
        {selected === "directory" ? <DirectoryPanel /> : null}
        {selected === "fx" ? <FxPanel /> : null}
        {selected === "data-rights" ? <DataRightsPanel /> : null}
        {selected === "metrics" ? <MetricsPanel /> : null}
      </TabPanel>
    </div>
  );
}
