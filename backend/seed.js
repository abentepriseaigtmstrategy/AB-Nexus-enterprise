// backend/seed.js - Seed initial data for development
export async function seedDatabase(env) {
console.log('Seeding database...');
// Create super admin tenant
const superTenantId = crypto.randomUUID();
await env.DB.prepare(
'INSERT INTO tenants (id, name, subscription_tier, settings, created_at) V
ALUES (?, ?, ?, ?, ?)'
).bind(superTenantId, 'McLarens Nexus Enterprise', 'enterprise', JSON.stringif
y({ theme: 'dark', features: 'all' }), Date.now()).run();
// Create super admin user
const superAdminId = crypto.randomUUID();
const encoder = new TextEncoder();
const salt = crypto.randomBytes(16).toString('hex');
const passwordData = encoder.encode('Admin@2026' + salt);
const hashBuffer = await crypto.subtle.digest('SHA-256', passwordData);
const hash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).pa
dStart(2, '0')).join('');
await env.DB.prepare(

`INSERT INTO users (id, email, name, role, tenant_id, password_hash, passw
ord_salt, email_verified, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
).bind(superAdminId, 'admin@mclarens.com', 'Super Admin', 'super_admin', super
TenantId, hash, salt, 1, Date.now()).run();
// Create sample tenant
const sampleTenantId = crypto.randomUUID();
await env.DB.prepare(
'INSERT INTO tenants (id, name, subscription_tier, settings, created_at) V
ALUES (?, ?, ?, ?, ?)'
).bind(sampleTenantId, 'Sample Insurance Corp', 'pro', JSON.stringify({ theme:
'dark' }), Date.now()).run();
// Create sample admin user
const sampleAdminId = crypto.randomUUID();
const sampleSalt = crypto.randomBytes(16).toString('hex');
const samplePasswordData = encoder.encode('Welcome@2026' + sampleSalt);
const sampleHashBuffer = await crypto.subtle.digest('SHA-256', samplePasswordD
ata);
const sampleHash = Array.from(new Uint8Array(sampleHashBuffer)).map(b => b.toS
tring(16).padStart(2, '0')).join('');
await env.DB.prepare(
`INSERT INTO users (id, email, name, role, tenant_id, password_hash, passw
ord_salt, email_verified, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
).bind(sampleAdminId, 'demo@sample.com', 'Demo User', 'admin', sampleTenantId,
sampleHash, sampleSalt, 1, Date.now()).run();
// Create sample employee
const employeeId = crypto.randomUUID();
await env.DB.prepare(
`INSERT INTO employees (id, user_id, tenant_id, employee_code, name, email
, department, designation, status, joining_date, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).bind(employeeId, sampleAdminId, sampleTenantId, 'EMP001', 'Demo User', 'demo
@sample.com', 'Administration', 'Administrator', 'active', Date.now(), Date.now())
.run();
// Create leave balance
const currentYear = new Date().getFullYear();

await env.DB.prepare(
`INSERT INTO leave_balances (id, tenant_id, employee_id, year, casual_bala
nce, sick_balance, annual_balance, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
).bind(crypto.randomUUID(), sampleTenantId, employeeId, currentYear, 12, 12, 1
5, Date.now()).run();
// Create sample claim
const claimId = crypto.randomUUID();
await env.DB.prepare(
`INSERT INTO claims (id, claim_number, tenant_id, policy_number, insurer_n
ame, insured_name, department,
sum_insured, loss_amount, claim_status, incident_date, intimation_date, c
ircumstances, created_by, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).bind(
claimId, 'CLM-2026001', sampleTenantId, 'POL-001', 'ICICI Lombard', 'Sampl
e Insured Pvt Ltd',
'burglary', 2500000, 825000, 'in_progress', Date.now() - 5 * 24 * 60 * 60
* 1000, Date.now() - 3 * 24 * 60 * 60 * 1000,
'Burglary incident at warehouse. Forced entry through rear shutter.', samp
leAdminId, Date.now()
).run();
console.log('Database seeded successfully!');
console.log('Super Admin Login: admin@mclarens.com / Admin@2026');
console.log('Demo Login: demo@sample.com / Welcome@2026');
}