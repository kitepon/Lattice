/** Only a fixed phase name crosses this channel; no project data or errors. */
export function dashboardLifecyclePhase(phase) {
  if (!process.connected) return;
  process.send({ type: 'dashboard_phase', phase }, () => {});
}
