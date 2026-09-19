function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({
  name,
  color,
  size = 36,
  title,
}: {
  name: string;
  color: string;
  size?: number;
  title?: string;
}) {
  return (
    <div
      className="avatar"
      title={title ?? name}
      style={{
        width: size,
        height: size,
        background: color,
        fontSize: Math.max(11, size * 0.38),
      }}
    >
      {initials(name)}
    </div>
  );
}
