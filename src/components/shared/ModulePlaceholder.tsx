import React from "react";
import { useI18nStore } from "@/i18n";
import { Page, PageHeader, EmptyState } from "@/components/ui";
import { WinUIButton } from "@/components/winui/WinUIButton";

interface PlaceholderModuleProps {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  actionText?: string;
  onAction?: () => void;
}

export const ModulePlaceholder: React.FC<PlaceholderModuleProps> = ({
  title,
  description,
  icon: Icon,
  actionText = "Start Scan",
  onAction,
}) => {
  const { t } = useI18nStore();
  return (
    <Page>
      <PageHeader icon={<Icon />} title={title} description={description} />
      <EmptyState
        icon={<Icon />}
        title={t.layout.readyToScan}
        description={t.layout.readyToScanDesc}
        action={
          <WinUIButton variant="primary" onClick={onAction}>
            {actionText}
          </WinUIButton>
        }
      />
    </Page>
  );
};
