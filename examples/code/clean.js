// Overdue reminders for the tool library: finds loans more than a day late and emails the member.
import { readFile } from 'node:fs/promises';
import { sendEmail } from './mail.js';
import { formatDate } from './dates.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export class LoanError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export async function readLoans(file = 'loans.json') {
  return JSON.parse(await readFile(file, 'utf8'));
}

export function overdueLoans(loans, now) {
  return loans.filter((loan) => !loan.returned && loan.due && now - loan.due > DAY_MS);
}

export async function remind(loan) {
  if (!loan.member?.email) {
    throw new LoanError('NO_MEMBER_EMAIL', `Loan ${loan.id} has no member email: add one on the members page, then send the reminder again.`);
  }
  await sendEmail(loan.member.email, `Please return the ${loan.tool} (due ${formatDate(loan.due)})`);
}
