NivØx MODS — Public deployment (free starter setup)

This version uses PostgreSQL so activation keys are not stored on the web server's temporary filesystem.

WHAT YOU NEED
- A GitHub account
- A Render account
- A Neon account (free PostgreSQL database)

STEP 1 — CREATE THE DATABASE
1. Open https://neon.tech and create a free project.
2. In the Neon dashboard, click Connect.
3. Copy the PostgreSQL connection string. Keep it private.

STEP 2 — PUT THE PROJECT ON GITHUB
1. Extract this ZIP on your phone or computer.
2. Create a new private repository on https://github.com/new (recommended).
3. Upload the contents of this folder to the repository. Upload the files/folders themselves, not the outer ZIP.
4. Do not upload passwords or database credentials. No secrets are stored in this project.

STEP 3 — DEPLOY ON RENDER
1. Open https://render.com and sign up.
2. Choose New > Web Service.
3. Connect GitHub and select your NivØx repository.
4. Set:
   Build Command: npm install
   Start Command: npm start
   Instance Type: Free
5. In Environment Variables, add:
   ADMIN_PASSWORD = a long private password (at least 12 characters)
   DATABASE_URL = the Neon connection string copied in Step 1
6. Click Create Web Service and wait for deployment.
7. Render gives your site a public address ending in .onrender.com.

STEP 4 — USE THE WEBSITE
- Open your public Render address.
- Admin key manager: enter ADMIN_PASSWORD.
- Set Hours before clicking Generate key.
- Copy the generated key and send it to the player.
- Refresh the list to see keys; Disable revokes a key immediately.

KEY EXPIRY
1 = one hour
24 = one day
168 = seven days
720 = 30 days
8760 = one year (maximum)

IMPORTANT
- Render free web services sleep after 15 minutes without traffic and may take about a minute to wake.
- Neon free plan limits and terms can change; check its current dashboard.
- Keep ADMIN_PASSWORD and DATABASE_URL secret. Never put them in public GitHub files or share them with users.
- This free setup is suitable for a test/hobby site, not a guaranteed always-on commercial service.
- This is not yet deployed: you must create/connect your own GitHub, Neon and Render accounts and complete the steps above.
- Physical phone DPI and total internal storage cannot be reliably read by an ordinary website. The dashboard explains these limitations.
- No cheats, aimbots, game-file modifications or unfair gameplay hacks are included.