# คู่มือติดตั้งระบบ CRM มดงานการป้าย

> ใช้เวลาประมาณ **30–45 นาที** · ทำตามทีละขั้น ไม่ต้องข้าม
> ทำเสร็จแล้วจะได้: เว็บที่ล็อกอินครั้งเดียว เห็นทุกแอปในหน้าเดียว

---

## สิ่งที่ต้องมีก่อนเริ่ม

| ต้องมี | ใช้ทำอะไร | ค่าใช้จ่าย |
|---|---|---|
| บัญชี **Supabase** | ฐานข้อมูล | ฟรี (Pro ~$25/เดือน เมื่อข้อมูลโต) |
| บัญชี **Railway** | ที่รันเว็บ | ~$5/เดือน |
| บัญชี **GitHub** | เก็บโค้ด + deploy อัตโนมัติ | ฟรี |
| ไฟล์ CSV ของชีต **User** | นำเข้าผู้ใช้ | — |

---

# ขั้นที่ 1 · สร้างฐานข้อมูล Supabase

### 1.1 สร้างโปรเจกต์
1. เข้า **https://supabase.com** → `Sign in with GitHub`
2. `New project`
   - **Name**: `crm-modngan`
   - **Database Password**: กดสุ่ม แล้ว **คัดลอกเก็บไว้ที่ปลอดภัย**
   - **Region**: เลือกที่ใกล้ไทยที่สุดเท่าที่มีให้เลือก
     (แผนฟรีมักเหลือแค่ `Northeast Asia (Seoul)` — **ใช้ได้ ไม่ต้องกังวล**
      ของเดิมบน Apps Script ช้า 3–10 วินาที · Seoul ~0.4 วินาที · Singapore ~0.2 วินาที
      ต่างกันแค่ 0.2 วินาที แต่เร็วขึ้นจากเดิมสิบเท่า)
3. กด `Create new project` → รอ ~2 นาที

### 1.2 สร้างตาราง  ← **ต้องทำก่อนขั้น 1.3 เสมอ**
1. เมนูซ้าย → **SQL Editor** → `New query`
2. เปิดไฟล์ `sql/01-core.sql` **คัดลอกทั้งไฟล์** → วาง → กด **Run**
3. ต้องขึ้น `Success. No rows returned` ✅

> จะเห็น NOTICE เรื่อง trigger ... does not exist, skipping — **ปกติ** ไม่ใช่ error

ตรวจว่าได้ครบ — รันคำสั่งนี้ต่อ ต้องได้ **5 แถว**:
```sql
select table_name, table_type
from information_schema.tables
where table_schema = 'app'
order by table_name;
```
(`app_users`, `auth_audit` เป็น BASE TABLE + วิว 3 ตัว)

### 1.3 เปิดให้ระบบมองเห็น schema `app`
เมนูซ้าย → **Integrations** → **Data API** → **Settings** → ช่อง **Exposed schemas**
→ กดเลือก **`app`** เพิ่มเข้าไป → `Save`

ต้องขึ้นว่า **`3 of 3 schemas exposed`** (`public`, `graphql_public`, `app`) ✅

> ⚠️ ช่องนี้จะ **ไม่มี `app` ให้เลือก** ถ้ายังไม่ได้รันขั้น 1.2
> เพราะมันแสดงเฉพาะ schema ที่มีอยู่จริงในฐานข้อมูลแล้ว — **นี่คือเหตุผลที่ต้องทำ 1.2 ก่อน**
> ถ้าลืมขั้นนี้ ระบบจะขึ้น error `PGRST106 / schema must be one of the following`

### 1.4 เก็บกุญแจ 2 ตัว
เมนูซ้าย → **Project Settings** (เฟือง) → **API Keys**

| ช่อง | เอาไปใส่ตัวแปร | หมายเหตุ |
|---|---|---|
| **Project URL** (อยู่ที่หน้า Data API) | `SUPABASE_URL` | เช่น `https://abcd1234.supabase.co` |
| **service_role** (กด `Reveal`) | `SUPABASE_KEY` | 🔴 **ห้ามส่งในไลน์ · ห้าม commit ขึ้น git** |

> ⚠️ ต้องใช้ **service_role** ไม่ใช่ `anon` — ถ้าใช้ผิดตัวจะอ่านข้อมูลไม่ได้เลย
> (ตาราง `app_users` เปิด RLS ไว้แต่ไม่มี policy — คีย์ `anon` จึงอ่านอะไรไม่ได้เลย ตั้งใจให้เป็นแบบนั้น)

---

# ขั้นที่ 2 · สร้างรหัสลับของระบบ

`SESSION_SECRET` คือรหัสยาว ๆ ที่ระบบใช้เซ็น cookie ตอนล็อกอิน

**ถ้ามี Terminal** (Mac/Linux):
```bash
openssl rand -hex 32
```

**ถ้าไม่มี / ใช้ Windows** — สร้างจาก Supabase ได้เลย
เมนูซ้าย → **SQL Editor** → วางแล้ว Run:
```sql
select encode(gen_random_bytes(32), 'hex') as session_secret;
```

ได้ตัวอักษรยาว 64 ตัว → **คัดลอกเก็บไว้** จะใช้เป็น `SESSION_SECRET`

> รหัสนี้ใช้เซ็นการล็อกอิน ถ้าเปลี่ยน ทุกคนจะถูกเด้งออกและต้องล็อกอินใหม่

---

# ขั้นที่ 3 · สร้างบัญชีผู้ใช้

## ทางที่ 1 · ไม่ต้องลงโปรแกรมอะไรเลย (แนะนำสำหรับเริ่มทดสอบ)

เมนูซ้าย → **SQL Editor** → วางแล้ว Run:
```sql
create extension if not exists pgcrypto;

insert into app.app_users
  ("Name", "Nickname", "Username", "PasswordHash", "Status", "Permission")
values
  ('ชื่อจริง', 'ชื่อเล่น', 'admin', crypt('รหัสที่ต้องการ', gen_salt('bf', 10)), 'Login', 'Administrator')
on conflict do nothing;
```

`crypt(..., gen_salt('bf',10))` ให้ bcrypt hash แบบเดียวกับที่ระบบใช้พอดี — ล็อกอินได้ทันที

ตรวจว่าไม่มีรหัสข้อความล้วนหลุดเข้าฐานข้อมูล:
```sql
select "Username", "Permission", "Status",
       case when "PasswordHash" like '$2%' then '🔒 เข้ารหัสแล้ว' else '⚠️ ยังไม่เข้ารหัส' end as pw
from app.app_users order by "Username";
```

## ทางที่ 2 · นำเข้าทั้งชีต User ทีเดียว (ต้องมี Node.js ในเครื่อง)

### 3.1 ดาวน์โหลดชีต User
1. เปิดไฟล์ **Login CRM** → แท็บ **User**
2. `File → Download → Comma-separated values (.csv)`

### 3.2 นำเข้า
```bash
cd crm-hub
npm install

# ใส่ค่าที่ได้จากขั้น 1–2
export SUPABASE_URL="https://xxxx.supabase.co"
export SUPABASE_KEY="eyJhbGciOi..."
export SESSION_SECRET="ที่ได้จากขั้นที่ 2"

npm run import-users ~/Downloads/User.csv
```

จะขึ้นแบบนี้:
```
📋 พบ 42 แถว · คอลัมน์ที่จับคู่ได้:
   name   → "Name"
   user   → "Username"
   pass   → "Password"
   ...
✅ เพิ่มใหม่      42 คน
🔐 เข้ารหัสผ่าน   42 คน (bcrypt)
```

> 🔒 **รหัสผ่านทุกคนถูกเข้ารหัสตอนนำเข้าทันที** ฐานข้อมูลไม่มีรหัสข้อความล้วน
> ⚠️ **ลบไฟล์ CSV ทิ้งทันทีหลังนำเข้าเสร็จ** — ในไฟล์นั้นมีรหัสผ่านจริงทุกคน

### 3.3 ตรวจว่าเรียบร้อย
```bash
npm run doctor
```
ต้องขึ้น `✅ ระบบพร้อมใช้งาน`

---

# ขั้นที่ 4 · (ข้ามได้) ทดลองรันในเครื่องก่อน

> ขั้นนี้ต้องมี Node.js — **ถ้าไม่มี ข้ามไปขั้นที่ 5 ได้เลย** Railway จะ build ให้เอง

```bash
npm start
```
เปิดเบราว์เซอร์ไปที่ **http://localhost:3000**

ลองล็อกอินด้วย **username + รหัสผ่านเดิมจากชีต** — ต้องเข้าได้เลยโดยไม่ต้องตั้งรหัสใหม่

✅ ถ้าเห็นหน้ารวมแอป = ระบบทำงานถูกต้อง ไปขั้นต่อไปได้

---

# ขั้นที่ 5 · ขึ้นออนไลน์ด้วย Railway

### 5.1 เอาโค้ดขึ้น GitHub

**ทางที่ 1 · ผ่านหน้าเว็บ ไม่ต้องลง git** (แนะนำ)
1. เข้า **https://github.com/new**
   - Repository name: `crm-hub`
   - เลือก **Private** 🔴 (สำคัญ)
   - กด `Create repository`
2. หน้าถัดมากด **`uploading an existing file`**
3. แตกไฟล์ zip ในเครื่อง แล้ว **ลากทั้งโฟลเดอร์** `crm-hub` ทิ้งลงในหน้าเว็บ
4. กด `Commit changes`

**ทางที่ 2 · ถ้ามี git อยู่แล้ว**
```bash
cd crm-hub
git init && git add . && git commit -m "ระบบ CRM รวมทุกแอป"
git remote add origin https://github.com/<ชื่อคุณ>/crm-hub.git
git branch -M main && git push -u origin main
```

> ✅ ไฟล์ `.gitignore` กัน `.env` และไฟล์ `.csv` ไม่ให้ขึ้น git ไว้แล้ว
> 🔴 อย่าอัปโหลดไฟล์ `.env` ที่มีคีย์จริงขึ้น GitHub เด็ดขาด — คีย์ทั้งหมดใส่ที่ Railway อย่างเดียว

### 5.2 สร้างบริการบน Railway
1. เข้า **https://railway.app** → `Login with GitHub`
2. `New Project` → `Deploy from GitHub repo` → เลือก `crm-hub`
3. Railway จะเริ่ม build เอง (ใช้ `Dockerfile` ที่มีให้แล้ว)

### 5.3 ใส่ตัวแปร
แท็บ **Variables** → `New Variable` ใส่ทีละตัว:

```
SUPABASE_URL       = https://xxxx.supabase.co
SUPABASE_KEY       = eyJhbGciOi...        ← service_role
SESSION_SECRET     = (64 ตัวจาก openssl)
NODE_ENV           = production
TZ                 = Asia/Bangkok
SESSION_HOURS      = 12
```

### 5.4 เปิดให้เข้าจากอินเทอร์เน็ต
แท็บ **Settings** → **Networking** → `Generate Domain`
จะได้ URL เช่น `https://crm-hub-production.up.railway.app`

### 5.5 ตรวจว่าใช้ได้
เปิด `https://<โดเมนของคุณ>/healthz` ต้องได้:
```json
{"ok":true,"db":{"ok":true},"modules":{"total":12,...}}
```

🎉 **เสร็จแล้ว** — ส่ง URL ให้ทีมใช้ได้เลย

---

# การใช้งานประจำวัน

### แก้โค้ดแล้วขึ้นเวอร์ชันใหม่
```bash
git add .
git commit -m "อธิบายว่าแก้อะไร"
git push
```
Railway ขึ้นเวอร์ชันใหม่ให้อัตโนมัติภายใน ~1 นาที
**ไม่ต้องกด Deploy > New version ทีละแอปเหมือน Apps Script อีกแล้ว**

### ย้อนกลับเวอร์ชันเดิม (ถ้าแก้แล้วพัง)
Railway → **Deployments** → เลือกเวอร์ชันที่ดี → `Redeploy`

### ปิดระบบชั่วคราวตอนปรับปรุง
เพิ่มตัวแปร `MAINTENANCE=1` → เหลือแต่ admin เข้าได้

### เพิ่ม / ปิดบัญชีผู้ใช้
ตอนนี้ทำผ่าน Supabase → **Table Editor** → `app_users`
- ปิดบัญชี: เปลี่ยน `Status` เป็น `Logout` → **เด้งออกทุกแอปทันที**
- ตั้งรหัสใหม่ (ทางเว็บ) — SQL Editor:
  ```sql
  update app.app_users
     set "PasswordHash" = crypt('รหัสใหม่', gen_salt('bf', 10)),
         "Password" = null
   where "Username" = 'ชื่อผู้ใช้';
  ```
- ตั้งรหัสใหม่ (ถ้ามี Node.js): `npm run set-password <username> <รหัสใหม่>`

> โมดูล "จัดการผู้ใช้" จะทำให้ทีหลัง ทำให้กดผ่านหน้าเว็บได้

### ดูว่าใครใช้อะไรบ้าง
Supabase → SQL Editor:
```sql
select * from app.v_usage_30d;        -- สรุปการใช้งาน 30 วัน
select * from app.v_login_failures;   -- คนที่ล็อกอินพลาดบ่อย (เผื่อมีคนเดารหัส)
select * from app.auth_audit order by at desc limit 100;   -- ล่าสุด 100 รายการ
```

---

# แก้ปัญหาที่พบบ่อย

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| `ยังไม่ได้ตั้งค่า SUPABASE_URL` | ยังไม่ได้ใส่ Variables ใน Railway |
| `SESSION_SECRET สั้นเกินไป` | ต้องยาว ≥32 ตัว — สร้างใหม่ด้วย `openssl rand -hex 32` |
| ล็อกอินขึ้น "ไม่พบชื่อผู้ใช้" | ยังไม่ได้นำเข้าผู้ใช้ → `npm run import-users` |
| ล็อกอินขึ้น "บัญชีนี้ถูกปิดการใช้งาน" | `Status` ในตารางเป็น `Logout` |
| `/healthz` ขึ้น `db.ok = false` | ยังไม่ได้รัน `sql/01-core.sql` หรือใส่ key ผิดตัว (ต้องเป็น service_role) |
| `PGRST106` / `schema must be one of the following` | ยังไม่ได้เพิ่ม `app` ใน **Exposed schemas** → ย้อนไปทำขั้น **1.3** |
| ไม่มี `app` ให้เลือกใน Exposed schemas | ยังไม่ได้รัน `sql/01-core.sql` → ทำขั้น **1.2** ก่อน แล้วรีเฟรชหน้า |
| ทุกคนถูกเด้งออกพร้อมกัน | `SESSION_SECRET` เปลี่ยน — ให้ล็อกอินใหม่ |
| การ์ดแอปกดไม่ได้ (จาง ๆ) | โมดูลนั้นยังไม่ได้ย้ายเข้าระบบ (สถานะ `planned`) |

---

# สถานะโมดูลตอนนี้

| โมดูล | สถานะ |
|---|---|
| คีย์ยอดขาย · Projects Management | 🟡 กำลังย้าย |
| Job Card · จองคิวช่าง · Profile ช่าง · รีวิว · Checklist | 📋 ยังไม่เริ่ม |
| After-Sale · Inventory · ใบขอซื้อ | 📋 ยังไม่เริ่ม |
| จัดการผู้ใช้ · บันทึกการใช้งาน | 📋 ยังไม่เริ่ม |

โมดูลที่ยังไม่ย้ายจะขึ้นเป็นการ์ดสีจาง กดไม่ได้ — **ระหว่างนี้ใช้แอปเดิมไปก่อนได้ตามปกติ**
ย้ายเสร็จทีละตัว การ์ดก็จะเปิดใช้ได้ทีละตัว

---

# ความปลอดภัย — สิ่งที่ต้องระวัง

🔴 **`SUPABASE_KEY` (service_role)** — คีย์นี้เปิดฐานข้อมูลได้ทั้งหมด
- อยู่ใน Railway Variables เท่านั้น
- ห้ามส่งในไลน์ · ห้ามใส่ในโค้ด · ห้าม commit ขึ้น git
- ถ้าหลุด: Supabase → **Project Settings → API Keys** → `Reset service_role key` แล้วอัปเดตใน Railway

🔴 **ไฟล์ CSV ที่ดาวน์โหลดมา** — มีรหัสผ่านจริงทุกคน **ลบทิ้งทันทีหลังนำเข้า**

🟢 **สิ่งที่ระบบกันให้แล้ว**
- รหัสผ่านเก็บเป็น bcrypt — ฐานข้อมูลหลุดก็อ่านรหัสไม่ได้
- cookie เป็น httpOnly — JavaScript ในหน้าเว็บขโมยไปไม่ได้
- ทุกโมดูลตรวจสิทธิ์ฝั่งเซิร์ฟเวอร์ — ยิง API ตรงก็ไม่ผ่าน
- ปิดบัญชีแล้วเด้งออกทันทีทุกแอป ไม่ต้องรอ session หมดอายุ
- ทุกการเข้าใช้ถูกบันทึกใน `auth_audit` — ตรวจย้อนหลังได้
