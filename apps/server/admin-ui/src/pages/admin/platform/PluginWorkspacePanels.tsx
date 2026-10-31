import { useEffect, useState } from "react";
import PluginPanelFrame from "@components/PluginPanelFrame";
import { localizedLabel, type LocalizedLabel } from "../../../config/admin-nav";
import { useT } from "../../../i18n/I18nProvider";

interface WorkspacePanel {
  pluginId: string;
  id: string;
  title: LocalizedLabel;
  app: string;
  catalogs?: Record<string, string>;
}

/**
 * Cards active plugins add to this workspace (`workspacePanels`).
 * Each card is the plugin's own screen; the host passes the workspace id.
 */
export default function PluginWorkspacePanels({ workspaceId }: { workspaceId: string }) {
  const { locale } = useT();
  const [panels, setPanels] = useState<WorkspacePanel[]>([]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/plugins/workspace-panels")
      .then(async (res) => (res.ok ? ((await res.json()) as { panels?: WorkspacePanel[] }) : {}))
      .then((body) => {
        if (!cancelled) setPanels(Array.isArray(body.panels) ? body.panels : []);
      })
      .catch(() => {
        if (!cancelled) setPanels([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      {panels.map((panel) => {
        const title = localizedLabel(panel.title, locale);
        return (
          <section className="jf-card" key={`${panel.pluginId}:${panel.id}`}>
            <div className="jf-card__head">
              <h2 className="jf-card__title">{title}</h2>
            </div>
            <div className="jf-card__body">
              <PluginPanelFrame
                pluginId={panel.pluginId}
                app={panel.app}
                target={{ workspaceId }}
                catalogs={panel.catalogs}
                title={title}
              />
            </div>
          </section>
        );
      })}
    </>
  );
}
