export const USER_SKILLS_STATUS_CHANGED_EVENT = 'netcatty:user-skills-status-changed';
const USER_SKILLS_STATUS_CHANGED_KEY = 'ai:user-skills-status-changed';

type SettingsBridge = {
  notifySettingsChanged?: (payload: { key: string; value: unknown }) => void;
  onSettingsChanged?: (callback: (payload: { key: string; value: unknown }) => void) => () => void;
};

function getSettingsBridge(): SettingsBridge | undefined {
  return (window as unknown as { netcatty?: SettingsBridge }).netcatty;
}

export function notifyUserSkillsStatusChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(USER_SKILLS_STATUS_CHANGED_EVENT));
  getSettingsBridge()?.notifySettingsChanged?.({
    key: USER_SKILLS_STATUS_CHANGED_KEY,
    value: Date.now(),
  });
}

export function subscribeUserSkillsStatusChanged(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const handleLocalEvent = () => callback();
  window.addEventListener(USER_SKILLS_STATUS_CHANGED_EVENT, handleLocalEvent);

  const unsubscribeSettings = getSettingsBridge()?.onSettingsChanged?.((payload) => {
    if (payload.key === USER_SKILLS_STATUS_CHANGED_KEY) {
      callback();
    }
  });

  return () => {
    window.removeEventListener(USER_SKILLS_STATUS_CHANGED_EVENT, handleLocalEvent);
    unsubscribeSettings?.();
  };
}
