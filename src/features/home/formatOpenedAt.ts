/** 最近文件打开时间的中文展示：7 天内相对时间，更早回退为「年-月-日 时:分」。 */
export function formatOpenedAt(openedAt: number): string {
  if (!Number.isFinite(openedAt)) return "时间未知";
  // 时钟回拨等导致 openedAt 在未来时，按「刚刚」展示，避免出现负数。
  const diff = Date.now() - openedAt;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  const date = new Date(openedAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
