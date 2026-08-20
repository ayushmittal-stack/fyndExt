import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import { ExperienceSwitch } from '../../../components/oms/ExperienceSwitch';

describe('ExperienceSwitch', () => {
  test('announces the selected experience', () => {
    render(<ExperienceSwitch mode="classic" onChange={() => {}} />);

    expect(screen.getByRole('group', { name: 'Choose extension experience' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Classic' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'New OMS' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('requests a mode change once', () => {
    const onChange = jest.fn();
    render(<ExperienceSwitch mode="classic" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'New OMS' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('oms');
  });

  test('does not request a change for the selected experience', () => {
    const onChange = jest.fn();
    render(<ExperienceSwitch mode="classic" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Classic' }));

    expect(onChange).not.toHaveBeenCalled();
  });
});
