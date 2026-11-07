"use client";

import { useExtracted } from "next-intl";

import { GoogleAdsManager } from "./GoogleAdsManager";
import { GSCManager } from "./GSCManager";
import { SettingsSection, SettingsSections } from "./SettingsSection";

interface IntegrationsTabProps {
  /**
   * L'utilisateur administre-t-il ce site ? Exigé, sans valeur par défaut : un
   * défaut silencieux sur une permission verrouille tout le monde ou n'ouvre
   * rien, et les deux se lisent comme un fonctionnement normal.
   */
  isOwner: boolean;
  disabled?: boolean;
}

export function IntegrationsTab({ isOwner, disabled = false }: IntegrationsTabProps) {
  const t = useExtracted();

  return (
    <SettingsSections>
      <SettingsSection
        title={t("Google Search Console")}
        description={t("Connect your Google Search Console account to view search performance data")}
      >
        <GSCManager disabled={disabled} />
      </SettingsSection>

      <SettingsSection
        title={t("Google Ads")}
        description={t(
          "Send this site's conversions to a Google Ads account so campaigns can bid on what actually converts"
        )}
      >
        <GoogleAdsManager canManage={isOwner} disabled={disabled} />
      </SettingsSection>
    </SettingsSections>
  );
}
