export function formatTime(date) {
  return new Date(date).toLocaleTimeString("en-GB", { hour12: false });
}

export function humanizeSeconds(total) {
  if (total < 60) return `${total}s`;

  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;

  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

export function tokenTiming(token) {
  const obtainedAt = new Date(token.obtained_at);
  const expiresAt = new Date(obtainedAt.getTime() + token.expires_in * 1000);
  const secondsLeft = Math.round((expiresAt - Date.now()) / 1000);

  return { obtainedAt, expiresAt, secondsLeft, expired: secondsLeft <= 0 };
}
