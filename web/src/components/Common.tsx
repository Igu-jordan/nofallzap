import { STATUS_LABEL, type InstanceStatus } from '../api';

export function StatusBadge({ status }: { status: InstanceStatus }) {
  return (
    <span className={`badge ${status}`}>
      <span className="dot" />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function Avatar({ url, name }: { url: string | null; name: string }) {
  if (url) return <img className="avatar" src={url} alt="" />;
  return <div className="avatar">{name.slice(0, 2).toUpperCase()}</div>;
}

export function Toggle({
  checked,
  onChange,
  disabled,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <label className="toggle" title={title} onClick={(e) => e.stopPropagation()}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="slider" />
    </label>
  );
}

export function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="error-box">{message}</div>;
}
