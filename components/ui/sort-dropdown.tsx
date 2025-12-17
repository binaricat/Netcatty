import { Calendar,CalendarClock,Check,ChevronDown,ChevronUp,SortAsc,SortDesc } from 'lucide-react';
import React from 'react';
import { useI18n } from "../../application/i18n/I18nProvider";
import { Button } from './button';
import { Dropdown,DropdownContent,DropdownTrigger } from './dropdown';

export type SortMode = 'az' | 'za' | 'newest' | 'oldest';

const SORT_OPTIONS: Record<SortMode, { labelKey: string; icon: React.ReactElement; triggerIcon: React.ReactElement }> = {
    az: { labelKey: 'sort.az', icon: <SortAsc className="w-4 h-4 shrink-0" />, triggerIcon: <SortAsc className="w-4 h-4" /> },
    za: { labelKey: 'sort.za', icon: <SortDesc className="w-4 h-4 shrink-0" />, triggerIcon: <SortDesc className="w-4 h-4" /> },
    newest: { labelKey: 'sort.newest', icon: <Calendar className="w-4 h-4 shrink-0" />, triggerIcon: <Calendar className="w-4 h-4" /> },
    oldest: { labelKey: 'sort.oldest', icon: <CalendarClock className="w-4 h-4 shrink-0" />, triggerIcon: <CalendarClock className="w-4 h-4" /> },
};

interface SortDropdownProps {
    value: SortMode;
    onChange: (mode: SortMode) => void;
    className?: string;
}

export const SortDropdown: React.FC<SortDropdownProps> = ({ value, onChange, className }) => {
    const [open, setOpen] = React.useState(false);
    const { t } = useI18n();

    return (
        <Dropdown open={open} onOpenChange={setOpen}>
            <DropdownTrigger asChild>
                <Button variant="ghost" size="icon" className={className || "h-8 w-8"}>
                    {SORT_OPTIONS[value].triggerIcon}
                    {open ? <ChevronUp size={10} className="ml-0.5" /> : <ChevronDown size={10} className="ml-0.5" />}
                </Button>
            </DropdownTrigger>
            <DropdownContent className="w-44" align="end">
                {(Object.keys(SORT_OPTIONS) as SortMode[]).map(mode => (
                    <Button
                        key={mode}
                        variant={value === mode ? 'secondary' : 'ghost'}
                        className="w-full justify-start gap-2 h-9"
                        onClick={() => {
                            onChange(mode);
                            setOpen(false);
                        }}
                    >
                        {SORT_OPTIONS[mode].icon} {t(SORT_OPTIONS[mode].labelKey)}
                        {value === mode && <Check size={12} className="ml-auto" />}
                    </Button>
                ))}
            </DropdownContent>
        </Dropdown>
    );
};

export default SortDropdown;
