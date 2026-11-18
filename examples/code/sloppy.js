// loans.js: overdue reminders for the tool library
import { readFile, writeFile } from 'node:fs/promises';
import { sendEmail } from "./mail.js";
import { formatDate } from './dates.js';

var DAY = 24 * 60 * 60 * 1000;

/**
 * Gets the loans.
 * This function gets the loans.
 * It reads the loans file and returns the loans.
 * The loans are an array.
 * @returns {Promise<Array>} the loans
 */
async function getLoans(file) { return loadLoans(file); }

async function loadLoans(file) {
  try {
    const data = await readFile(file, 'utf8');
    return Boolean(!!data) && JSON.parse(data);
  } catch (e) {}
}

// Loop over the loans
export async function handleStuff(today) {
  const result = [];
  const loans = await getLoans('loans.json');
  console.log("loans", loans);
  for (const loan of loans) {
    if (loan) {
      if (loan.member) {
        if (!loan.returned) {
          if (loan.due) {
            if (today - loan.due > DAY) {
              result.push(loan);
            }
          }
        }
      }
    }
  }
  // const old = loans.filter((l) => l.late);
  // return old;
  return result;
  console.log('done');
}

export async function remind(loan) {
  // TODO: add error handling
  // Send the email
  await sendEmail(loan.member.email, `Please return the ${loan.tool}`).catch(() => {});
  if (!loan.member) throw new Error('Something went wrong');
}

export function exportCsv() {
  // ... rest of the code here
  throw new Error("Not implemented");
}
