// One-time backfill: links existing Employee (HR) rows to their matching
// User (login account) row via Employee.user_id, now that the schema has
// the FK. Matches by CNIC first (exact, non-null, non-empty), then by phone
// for any Employee still unmatched. Only links when exactly one candidate
// User matches on each side — ambiguous matches are skipped and reported
// so a human can resolve them, rather than guessing.
//
// Run once: node linkEmployeesToUsers.js
// Safe to re-run — already-linked Employees (user_id not null) are skipped.

const prisma = require('./lib/prisma');

async function run() {
  const employees = await prisma.employee.findMany({ where: { user_id: null } });
  const users = await prisma.user.findMany({ select: { id: true, cnic: true, phone: true, full_name: true, username: true } });

  const usersByCnic = new Map();
  const usersByPhone = new Map();
  for (const u of users) {
    if (u.cnic) usersByCnic.set(u.cnic, [...(usersByCnic.get(u.cnic) || []), u]);
    if (u.phone) usersByPhone.set(u.phone, [...(usersByPhone.get(u.phone) || []), u]);
  }

  let linked = 0;
  let ambiguous = 0;
  let unmatched = 0;

  for (const emp of employees) {
    let candidates = [];

    if (emp.cnic && usersByCnic.has(emp.cnic)) {
      candidates = usersByCnic.get(emp.cnic);
    } else if (emp.phone && usersByPhone.has(emp.phone)) {
      candidates = usersByPhone.get(emp.phone);
    }

    if (candidates.length === 1) {
      const match = candidates[0];
      // A User can only be linked to one Employee (unique FK) — skip if
      // that User is already claimed by a different Employee found earlier
      // in this same run.
      const alreadyLinked = await prisma.employee.findUnique({ where: { user_id: match.id } });
      if (alreadyLinked) {
        console.log(`SKIP (User ${match.username} already linked to Employee #${alreadyLinked.employee_id}): Employee #${emp.employee_id} (${emp.full_name})`);
        ambiguous += 1;
        continue;
      }

      await prisma.employee.update({ where: { id: emp.id }, data: { user_id: match.id } });
      console.log(`LINKED: Employee #${emp.employee_id} (${emp.full_name}) -> User @${match.username} (id ${match.id})`);
      linked += 1;
    } else if (candidates.length > 1) {
      console.log(`AMBIGUOUS (${candidates.length} matches, skipped): Employee #${emp.employee_id} (${emp.full_name})`);
      ambiguous += 1;
    } else {
      unmatched += 1;
    }
  }

  console.log(`\nDone. Linked: ${linked}, Ambiguous/skipped: ${ambiguous}, No match: ${unmatched}, Total Employees checked: ${employees.length}`);
}

run()
  .catch((err) => {
    console.error('linkEmployeesToUsers failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
