import React, { memo, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';

const FALLBACK_ICON_URL = '/docker-icons/docker.svg';
const FALLBACK_TILE_BG = '#2496ED';

interface DockerImageIconProps {
  image: string;
  size?: number;
  className?: string;
}

export const DockerImageIcon = memo(function DockerImageIcon({
  image,
  size = 24,
  className,
}: DockerImageIconProps) {
  const [iconUrl, setIconUrl] = useState(FALLBACK_ICON_URL);
  const [tileBackground, setTileBackground] = useState(FALLBACK_TILE_BG);
  const [imgFailed, setImgFailed] = useState(false);
  const prevKeyRef = useRef('');

  const resetKey = `${image}`;
  useEffect(() => {
    if (prevKeyRef.current !== resetKey) {
      prevKeyRef.current = resetKey;
      setImgFailed(false);
      setIconUrl(FALLBACK_ICON_URL);
      setTileBackground(FALLBACK_TILE_BG);
    }
  }, [resetKey]);

  useEffect(() => {
    let cancelled = false;
    void import('../../domain/systemManager/dockerImageIcons').then((mod) => {
      if (cancelled) return;
      const iconId = mod.resolveDockerImageIcon(image);
      const presentation = mod.resolveDockerIconPresentation(iconId, {
        imageFailed: imgFailed,
      });
      const tile = mod.dockerIconTileStyle(presentation.displayIconId);
      setIconUrl(presentation.iconUrl);
      setTileBackground(tile.background);
    });
    return () => {
      cancelled = true;
    };
  }, [image, imgFailed]);

  const pad = 6;
  const box = size + pad * 2;

  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-md',
        className,
      )}
      style={{
        width: box,
        height: box,
        padding: pad,
        backgroundColor: tileBackground,
      }}
    >
      <img
        src={iconUrl}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        className="rounded object-contain"
        onError={() => setImgFailed(true)}
      />
    </div>
  );
});
