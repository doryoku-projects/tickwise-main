export function Card({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-border/60 bg-surface p-6 shadow-card ${className}`}>
      {children}
    </div>
  );
}
