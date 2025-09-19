export function formatDateISO(d: Date) {
  return d.toISOString().split("T")[0];
}

export function getLast7Days(startISO: string): string[] {
  const base = new Date(startISO);
  return Array.from({ length: 7 }).map((_, i) => {
    const d = new Date(base);
    d.setDate(base.getDate() - i);
    return formatDateISO(d);
  });
}
