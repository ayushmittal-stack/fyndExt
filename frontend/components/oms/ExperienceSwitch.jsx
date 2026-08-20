import React from 'react';

export function ExperienceSwitch({ mode, onChange }) {
  const options = [
    { value: 'classic', label: 'Classic' },
    { value: 'oms', label: 'New OMS' },
  ];

  return (
    <div
      className="extension-experience-switch"
      role="group"
      aria-label="Choose extension experience"
    >
      {options.map(option => {
        const selected = option.value === mode;
        return (
          <button
            key={option.value}
            type="button"
            className={`extension-experience-switch__option${selected ? ' is-selected' : ''}`}
            aria-pressed={selected}
            onClick={() => {
              if (!selected) onChange(option.value);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
