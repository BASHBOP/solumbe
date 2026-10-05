interface StreamAnalyticsPanelProps {
  viewers: number;
}

export const StreamAnalyticsPanel = ({ viewers }: StreamAnalyticsPanelProps) => <section>{viewers} viewers</section>;
