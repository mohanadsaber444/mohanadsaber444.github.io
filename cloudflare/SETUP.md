# إعداد لوحة المقالات الخاصة (Cloudflare Worker + GitHub App)

هذه البنية تُبقي موقعك العام على GitHub Pages، وتستضيف لوحة الإدارة على نفس نطاق Cloudflare Worker حتى تكون جلسة الدخول SameSite آمنة ولا تحتاج إلى مشاركة Cookies بين نطاقين.

## البنية الأمنية

- تسجيل الدخول عبر GitHub OAuth للتحقق من حسابك.
- يسمح Worker فقط بحساب GitHub المحدد في `ALLOWED_GITHUB_USERNAME`.
- لا يتم تخزين OAuth access token في Cookie أو المتصفح؛ يُستخدم للتحقق من الهوية فقط.
- النشر يتم بواسطة GitHub App مثبت على مستودع موقعك وحده، مع صلاحية Contents: Read and write.
- Worker ينشئ Installation Token قصير العمر ومحدودًا بالمستودع عند النشر.
- Cookie الجلسة: HttpOnly, Secure, SameSite=Lax، ومشفّرة بـ AES-GCM.
- لوحة الإدارة تُخدم من Worker، ولا تُنشر ملفاتها إلى GitHub Pages.
- المقالات المنشورة عامة. لا تكتب أسرارًا أو معلومات عملاء.

## 1. إعداد GitHub OAuth App

من GitHub → Settings → Developer settings → OAuth Apps → New OAuth App:

- Name: Mohanned Blog CMS
- Homepage URL: `https://mohanadsaber444.github.io`
- Callback URL: `https://YOUR-WORKER.workers.dev/auth/callback`

احتفظ بـ Client ID وClient Secret. لا تضع Client Secret في GitHub repository.

## 2. إعداد GitHub App للنشر المحدود

من GitHub → Settings → Developer settings → GitHub Apps → New GitHub App:

- GitHub App name: Mohanned Blog Publisher
- Homepage URL: موقعك
- Webhook: عطّله (غير مطلوب)
- Repository permissions → Contents: Read and write
- باقي الصلاحيات: No access
- Install only on this account

بعد إنشاء التطبيق:
1. سجّل **App ID**.
2. أنشئ Private Key ونزّله، واحفظه بأمان.
3. من Install App، ثبّت التطبيق على **مستودع الموقع فقط**: `mohanadsaber444.github.io`.
4. سجّل **Installation ID** من صفحة التثبيت أو رابطها.

لا تستخدم Personal Access Token لهذا النظام.

## 3. نشر Worker

من مجلد المشروع، انشر Worker باستخدام Wrangler. ملف `wrangler.toml` مرفق كقالب، ويجب تغيير `WORKER_ORIGIN` إلى عنوان Worker الحقيقي قبل النشر.

المتغيرات العامة في `wrangler.toml`:
- `SITE_ORIGIN`: `https://mohanadsaber444.github.io`
- `WORKER_ORIGIN`: عنوان Worker الكامل
- `ALLOWED_GITHUB_USERNAME`: `mohanadsaber444`
- `REPO_OWNER`: `mohanadsaber444`
- `REPO_NAME`: `mohanadsaber444.github.io`
- `REPO_BRANCH`: `main`
- `GITHUB_APP_ID`: App ID
- `GITHUB_APP_INSTALLATION_ID`: Installation ID
- `GITHUB_CLIENT_ID`: OAuth Client ID

أضف القيم السرية عبر Wrangler/Cloudflare Secrets فقط:
- `GITHUB_CLIENT_SECRET`: OAuth Client Secret
- `GITHUB_APP_PRIVATE_KEY`: محتوى Private Key كاملًا (PEM)
- `SESSION_ENCRYPTION_KEY`: مفتاح عشوائي 32-byte بصيغة Base64

توليد مفتاح الجلسة محليًا عبر Python:
```python
import secrets, base64
print(base64.b64encode(secrets.token_bytes(32)).decode())
```

لا تشارك هذه القيم في المحادثة أو ملفات المشروع.

## 4. إضافة Secrets ونشر Worker\n\nمن terminal داخل مجلد المستودع، بعد وضع قيم المتغيرات في `wrangler.toml`، أضف الأسرار التالية (سيطلب منك Wrangler إدخال كل قيمة):\n\n```bash\nnpx wrangler secret put GITHUB_CLIENT_SECRET\nnpx wrangler secret put GITHUB_APP_PRIVATE_KEY\nnpx wrangler secret put SESSION_ENCRYPTION_KEY\nnpx wrangler deploy\n```\n\nلا تحفظ قيم الأسرار في ملف أو ترسلها في المحادثة. بعد النشر، اختبر Worker على عنوانه.\n\n## 5. إعداد OAuth callback

ارجع إلى OAuth App واجعل callback:
`https://YOUR-WORKER.workers.dev/auth/callback`

ثم أعد نشر Worker بعد ضبط `WORKER_ORIGIN`.

## 6. اختبار قبل دمج Pull Request

1. افتح عنوان Worker، يجب أن تظهر لوحة الإدارة.
2. اضغط تسجيل الدخول، وتأكد أن GitHub يرجع إلى Worker.
3. جرّب الدخول بحساب غير `mohanadsaber444`؛ يجب أن يُرفض.
4. انشر مقالًا تجريبيًا غير حساس.
5. تأكد أن المقال أُضيف إلى `_posts/` وأن GitHub Pages بنى صفحة المقال.
6. اختبر تسجيل الخروج.
7. تأكد أن `/admin/` غير موجود ضمن ملفات GitHub Pages العامة.

بعد نجاح الاختبار، راجع Pull Request رقم 2 وادمجه. لم يتم دمج التغييرات تلقائيًا.

## ملاحظة عن GitHub Pages

ملف `_config.yml` يستبعد `admin` و`cloudflare` و`wrangler.toml` من مخرجات Jekyll. ملف `.gitignore` يساعد على تجنب نشر ملفات الإدارة في إعدادات أخرى. لا تغيّر إعداد Pages أو workflow موجودًا قبل التأكد من طريقة البناء الحالية.

## ملاحظة

النشر يكتب المقال مباشرة إلى الفرع المحدد بعد التحقق من الجلسة. لذلك اختبر أولًا على فرع تجريبي أو اترك `REPO_BRANCH` على فرع اختبار حتى تتأكد من البناء، ثم غيّره إلى `main`.
