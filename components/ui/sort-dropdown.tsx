import React from 'react';
import { Check, ChevronDown, ChevronUp, SortAsc, SortDesc, Calendar, CalendarClock } from 'lucide-react';
import { Button } from './button';
import { Dropdown, DropdownContent, DropdownTrigger } from './dropdown';

export type SortMode = 'az' | 'za' | 'newest' | 'oldest';

export const SORT_OPTIONS: Record<SortMode, { label: string; icon: React.ReactElement; triggerIcon: React.ReactElement }> = {
    az: { label: 'A-z', icon: <SortAsc className="w-4 h-4 shrink-0" />, triggerIcon: <SortAsc className="w-4 h-4" /> },
    za: { label: 'Z-a', icon: <SortDesc className="w-4 h-4 shrink-0" />, triggerIcon: <SortDesc className="w-4 h-4" /> },
    newest: { label: 'Newest to oldest', icon: <Calendar className="w-4 h-4 shrink-0" />, triggerIcon: <Calendar className="w-4 h-4" /> },
    oldest: { label: 'Oldest to newest', icon: <CalendarClock className="w-4 h-4 shrink-0" />, triggerIcon: <CalendarClock className="w-4 h-4" /> },
};

interface SortDropdownProps {
    value: SortMode;
    onChange: (mode: SortMode) => void;
    className?: string;
}

export const SortDropdown: React.FC<SortDropdownProps> = ({ value, onChange, className }) => {
    const [open, setOpen] = React.useState(false);

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
                        {SORT_OPTIONS[mode].icon} {SORT_OPTIONS[mode].label}
                        {value === mode && <Check size={12} className="ml-auto" />}
                    </Button>
                ))}
            </DropdownContent>
        </Dropdown>
    );
};

export default SortDropdown;
