import { memo, useState } from "react";

interface AnchorAvatarProps {
  avatarUrl: string | null;
  frameUrl: string | null;
}

// The caller keys this component by its URLs so a new connection can retry assets.
export const AnchorAvatar = memo(function AnchorAvatar({ avatarUrl, frameUrl }: AnchorAvatarProps) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [frameFailed, setFrameFailed] = useState(false);
  if (!avatarUrl || avatarFailed) {
    return null;
  }

  const showFrame = Boolean(frameUrl) && !frameFailed;
  return (
    <span className={`title-avatar${showFrame ? " has-frame" : ""}`} aria-hidden="true">
      <img
        className="title-avatar-image"
        src={avatarUrl}
        alt=""
        draggable={false}
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setAvatarFailed(true)}
      />
      {showFrame ? (
        <img
          className="title-avatar-frame"
          src={frameUrl!}
          alt=""
          draggable={false}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFrameFailed(true)}
        />
      ) : null}
    </span>
  );
});
