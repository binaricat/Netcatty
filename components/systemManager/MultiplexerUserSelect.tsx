import { memo } from 'react';
import { UserRound } from 'lucide-react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { MultiplexerUser } from '../../domain/systemManager/types';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';

interface MultiplexerUserSelectProps {
  users: MultiplexerUser[];
  currentUser: string;
  /** Effective user name (falls back to the current user). */
  value: string;
  /** Receives the selected user name; callers map the current user to "no scope". */
  onChange: (user: string) => void;
  disabled?: boolean;
}

/**
 * Shared user picker for the tmux/zellij manager tabs. Lists every login user
 * on the host so sessions owned by other users can be inspected through sudo.
 */
export const MultiplexerUserSelect = memo(function MultiplexerUserSelect({
  users,
  currentUser,
  value,
  onChange,
  disabled,
}: MultiplexerUserSelectProps) {
  const { t } = useI18n();
  const effective = value || currentUser;

  return (
    <Select value={effective} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        className="h-8 w-auto min-w-[7rem] max-w-[10rem] gap-1 px-2 text-xs"
        aria-label={t('systemManager.mux.user.label')}
      >
        <UserRound className="h-3.5 w-3.5 shrink-0 opacity-60" />
        <SelectValue placeholder={t('systemManager.mux.user.label')} />
      </SelectTrigger>
      <SelectContent>
        {users.map((user) => (
          <SelectItem key={user.name} value={user.name} className="text-xs">
            {user.name === currentUser
              ? `${user.name} (${t('systemManager.mux.user.current')})`
              : user.name}
          </SelectItem>
        ))}
        {users.length === 0 && currentUser && (
          <SelectItem value={currentUser} className="text-xs">
            {currentUser} ({t('systemManager.mux.user.current')})
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
});
