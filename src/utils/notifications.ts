import * as Notifications from 'expo-notifications';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function requestNotificationPermissions(): Promise<boolean> {
  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === 'granted') return true;
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

export async function scheduleExpiryNotifications(
  secretId: string,
  secretName: string,
  projectName: string,
  expiresAt: Date,
) {
  const hasPermission = await requestNotificationPermissions();
  if (!hasPermission) return;

  // Cancel any existing notifications for this secret
  await cancelExpiryNotifications(secretId);

  const now = new Date();
  const offsets = [
    { days: 7, label: 'in 7 days' },
    { days: 3, label: 'in 3 days' },
    { days: 1, label: 'tomorrow' },
    { days: 0, label: 'today' },
  ];

  for (const { days, label } of offsets) {
    const trigger = new Date(expiresAt);
    trigger.setDate(trigger.getDate() - days);
    trigger.setHours(9, 0, 0, 0); // 9 AM

    if (trigger <= now) continue;

    await Notifications.scheduleNotificationAsync({
      content: {
        title: `Secret Expiring ${label}`,
        body: `"${secretName}" in ${projectName} expires ${label}.`,
        data: { secretId, type: 'secret-expiry' },
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: trigger },
      identifier: `secret-expiry-${secretId}-${days}`,
    });
  }
}

export async function cancelExpiryNotifications(secretId: string) {
  for (const days of [7, 3, 1, 0]) {
    await Notifications.cancelScheduledNotificationAsync(
      `secret-expiry-${secretId}-${days}`,
    ).catch(() => {});
  }
}
