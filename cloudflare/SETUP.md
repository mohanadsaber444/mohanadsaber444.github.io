# إعداد لوحة المقالات الخاصة

هذا الإعداد يضيف محررًا خاصًا إلى موقع GitHub Pages، ويستخدم Cloudflare Worker للمصادقة والنشر عبر GitHub API. لا تنشر قيم الأسرار في هذا المستودع.

## البنية

- الموقع العام يبقى على GitHub Pages.
- `/admin/` واجهة محرر ثابتة، لا تحتوي على أسرار.
- Worker يحمي API ويعالج GitHub OAuth.
- المقالات تُكتب في `_posts/YYYY-MM-DD-slug.md` ويحوّلها Jekyll إلى صفحات عامة.
- GitHub Pages يبني الموقع تلقائيًا عند وصول commit.

## 1. أنشئ GitHub OAuth App

في GitHub: Settings → Developer settings → OAuth Apps → New OAuth App.

- Application name: Mohanned Blog CMS
- Homepage URL: `https://mohanadsaber444.github.io`
- Authorization callback URL: `https://YOUR-WORKER.workers.dev/auth/callback`

احتفظ بـ Client ID، وأنشئ Client Secret. لا تضع Client Secret في أي ملف داخل GitHub.

OAuth App يستخدم نطاق `public_repo` ليكتب إلى المستودع العام. لا تستخدم هذا التطبيق لأي غرض آخر.

## 2. أنشئ Cloudflare Worker

في Cloudflare Dashboard → Workers & Pages → Create Worker. انشر محتوى `worker.js` من هذا المجلد.

عيّن Variables:
- `SITE_ORIGIN`: `https://mohanadsaber444.github.io`
- `WORKER_ORIGIN`: عنوان Worker الكامل، مثل `https://mohanned-blog-cms.<account>.workers.dev`
- `GITHUB_CLIENT_ID`: OAuth Client ID
- `ALLOWED_GITHUB_USERNAME`: `mohanadsaber444`
- `REPO_OWNER`: `mohanadsaber444`
- `REPO_NAME`: `mohanadsaber444.github.io`
- `REPO_BRANCH`: `main`

أضف Secrets من إعدادات Worker (لا تضعها في git):
- `GITHUB_CLIENT_SECRET`: OAuth Client Secret
- `SESSION_ENCRYPTION_KEY`: Base64 لمفتاح عشوائي 32-byte. يمكنك توليده محليًا عبر Python:
  ```python
  import secrets, base64
  print(base64.b64encode(secrets.token_bytes(32)).decode())
  ```

## 3. اربط واجهة الإدارة بالـ Worker

في `admin/index.html` غيّر `https://YOUR-WORKER.workers.dev` إلى عنوان Worker الحقيقي. هذا عنوان عام وليس سرًا.

## 4. مهم: إعداد callback وCookie

يجب أن يكون OAuth callback هو `WORKER_ORIGIN/auth/callback`. الـ Worker يتحقق من OAuth state عبر Cookie HttpOnly، ويقصر الجلسة على اسم GitHub المسموح، ويشفّر رمز الجلسة بـ AES-GCM.

## 5. إعداد GitHub Pages للبناء

من Settings → Pages، اختر نشر الموقع من branch `main` / root. وجود `_config.yml` يجعل GitHub Pages يبني ملفات Markdown في `_posts` باستخدام Jekyll.

تحقق من أن إعداد Pages الحالي يسمح ببناء Jekyll. إذا كان لديك workflow خاص بالنشر، لا تستبدله قبل مراجعته.

## 6. اختبار قبل الاستخدام

1. جرّب Worker على عنوانه قبل وضعه في صفحة الإدارة.
2. افتح `/admin/` وسجّل الدخول بحساب `mohanadsaber444`.
3. جرّب نشر مقال تجريبي قصير.
4. تحقق من ظهوره في `/blog/` وفي Sitemap.
5. اختبر تسجيل الخروج ورفض حساب GitHub آخر.

## تنبيه

المقالات المنشورة عامة. لا تكتب معلومات خاصة أو أسرار شركات داخل المقالات. إعدادات OAuth/Worker هي خطوة منفصلة عن ملفات الموقع؛ لا يمكن إكمالها من خلال commit وحده، ويجب إضافة الأسرار في لوحة Cloudflare وGitHub يدويًا.
