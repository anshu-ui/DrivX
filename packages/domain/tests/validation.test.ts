import { describe, expect, it } from 'vitest';
import { emailSchema, signUpProfileInputSchema } from '../src/validation';

describe('emailSchema', () => {
  it('stores the address lowercased and trimmed', () => {
    expect(emailSchema.parse('  Amit@DrivX.Test ')).toBe('amit@drivx.test');
  });

  it('accepts an address with a subdomain and a plus tag', () => {
    expect(emailSchema.safeParse('a.b+c@mail.drivx.test').success).toBe(true);
  });

  it.each(['', 'no-at-sign', 'two@@at.test', 'no-domain@', 'short@x'])('refuses %j', (value) => {
    expect(emailSchema.safeParse(value).success).toBe(false);
  });

  it('explains the refusal instead of a generic parse error', () => {
    const result = emailSchema.safeParse('not an email');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Enter a valid email address');
  });

  it('refuses an address longer than a mailbox can hold', () => {
    expect(emailSchema.safeParse(`${'a'.repeat(250)}@drivx.test`).success).toBe(false);
  });
});

describe('signUpProfileInputSchema', () => {
  it('accepts the pair the first-run form submits', () => {
    const parsed = signUpProfileInputSchema.parse({
      fullName: 'Amit Chauhan',
      email: 'AMIT@example.test',
    });
    expect(parsed).toEqual({ fullName: 'Amit Chauhan', email: 'amit@example.test' });
  });

  it('refuses a one-character name', () => {
    expect(signUpProfileInputSchema.safeParse({ fullName: 'A', email: 'a@example.test' }).success)
      .toBe(false);
  });

  it('refuses a sign-up with no email', () => {
    expect(signUpProfileInputSchema.safeParse({ fullName: 'Amit', email: '' }).success).toBe(false);
  });
});
