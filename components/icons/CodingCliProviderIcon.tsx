import React, { memo, type SVGProps } from 'react';
import { cn } from '../../lib/utils';
import type { CodingCliProviderId } from '../../domain/codingCliProviders';
import type { CodingCliActivityPhase } from '../../domain/codingCliTitleParse';
import { getAgentIconVisual, type AgentIconKey } from '../../domain/agentIcon';

type IconProps = SVGProps<SVGSVGElement>;

const ClaudeIcon: React.FC<IconProps> = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="75.73 64.08 872.25 872.25" fill="currentColor" {...props}>
    <path d="M616.9,649.5h-209.7c0,0,0,104.7,0,104.7h-56.6c0,0,.2-104.5.2-104.5h-48.6s.2,104.5.2,104.5h-56.7c0,0,.2-104.4.2-104.4l-48.6-.7v-96.4c.1,0-104.8,0-104.8,0v-104.9s104.9,0,104.9,0v-201.6c0,0,628.9,0,628.9,0v201.6c0,0,104.9,0,104.9,0v104.9s-104.9,0-104.9,0v96.6c.1,0-56.5.4-56.5.4l.2,104.5h-48.6s.2-104.6.2-104.6h-56.6s.2,104.6.2,104.6h-48.6s.2-104.6.2-104.6ZM351.1,447.5l-.5-96.4h-48.4c0,0,0,96.6,0,96.6l48.8-.2ZM722,447.7l-.4-96.7h-56.5c0,0,0,96.8,0,96.8h56.9Z" />
  </svg>
);

const OpencodeIcon: React.FC<IconProps> = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="444.00 174.00 312.00 312.00" fill="currentColor" {...props}>
    <path d="M520,180h200v300h-240V180h40ZM540,300v120h120v-180h-120v60Z" />
    <path d="M660,300v120h-120v-120h120Z" fillOpacity="0.5" />
  </svg>
);

const GeminiIcon: React.FC<IconProps> = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M12 0C12 6.627 6.627 12 0 12c6.627 0 12 5.373 12 12 0-6.627 5.373-12 12-12-6.627 0-12-5.373-12-12Z" />
  </svg>
);

const KimiIcon: React.FC<IconProps> = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="44.66 -14.44 1005.78 1005.78" fill="currentColor" {...props}>
    <path d="M766,79l-116.2,258.3c-14.5,24.1-34.5,44.7-58.5,59.5l-31.3,15.2c41.4,1.8,84.6-5,124.8,6.7,64.5,18.9,111.7,77.6,117.3,144.7v375.5h-163.5l-1.5-1.5v-433.5l-10.8,17.7c-22.9,32.8-59.7,52.9-99.7,55.3H229s0,362,0,362H64V80h165v332h207l145-333h185Z" />
    <path d="M843,246c2.6-6.4,20.9-24.1,20.9-29.5s-9.8-15.8-12.1-19.8c-34.4-61.1-9.7-148.5,68.6-153.7,75.8-5,110.7,48.4,100.3,119.3-8.3,56.3-43.8,74.5-96.2,79.8-27,2.7-54.5,3.3-81.5,4Z" />
  </svg>
);

const INLINE_PROVIDER_ICONS: Partial<Record<CodingCliProviderId, React.FC<IconProps>>> = {
  claude: ClaudeIcon,
  opencode: OpencodeIcon,
  gemini: GeminiIcon,
  kimi: KimiIcon,
};

const activityClassName: Record<CodingCliActivityPhase, string> = {
  idle: 'text-foreground dark:text-foreground',
  busy: 'text-sky-500 coding-cli-icon-busy',
  waiting: 'text-amber-500 coding-cli-icon-waiting',
};

export const CodingCliProviderIcon: React.FC<{
  providerId: CodingCliProviderId;
  iconKey?: AgentIconKey;
  activityPhase?: CodingCliActivityPhase;
  className?: string;
}> = memo(({ providerId, iconKey, activityPhase = 'idle', className }) => {
  const InlineIcon = INLINE_PROVIDER_ICONS[providerId];
  const boxClass = cn('shrink-0 h-4 w-4', className);
  const toneClass = activityClassName[activityPhase];

  if (InlineIcon) {
    return (
      <InlineIcon
        aria-hidden="true"
        className={cn(boxClass, toneClass)}
      />
    );
  }

  const visual = getAgentIconVisual(iconKey ?? providerId as AgentIconKey);
  return (
    <img
      src={visual.src}
      alt=""
      aria-hidden="true"
      className={cn(
        boxClass,
        'rounded-sm object-contain',
        visual.imageClassName,
        activityPhase === 'busy' && 'coding-cli-icon-busy opacity-100',
        activityPhase === 'waiting' && 'coding-cli-icon-waiting opacity-100',
      )}
    />
  );
});

CodingCliProviderIcon.displayName = 'CodingCliProviderIcon';
