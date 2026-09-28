// 认证页：登录 / 注册 / 找回密码（天空蓝品牌 + 植物线描 + 极致留白）

import { api, session } from "../api.js";
import { el, clear, field, toastOk, toastErr, botanical } from "../ui.js";
import { dragBar } from "../win.js";
import { go } from "../router.js";

function authShell(variant) {
  return el("div", { class: "auth-page" },
    dragBar({ height: 40, withControls: true }),
    botanical("branch", "top:40px;left:6%;width:130px;height:150px;opacity:0.35"),
    botanical("sprout", "bottom:48px;right:7%;width:120px;height:140px;opacity:0.3"),
    el("div", { class: "auth-brand" },
      el("div", { class: "logo" }, "途变"),
      el("div", { class: "tagline" }, "知道你在改变")
    ),
    variant
  );
}

function loginCard() {
  const card = el("div", { class: "auth-card" });
  const username = field("用户名 / 邮箱", "");
  const password = field("密码", "", { type: "password" });
  const captcha = field("验证码（不区分大小写）", "");
  const capImg = el("div", { class: "captcha-img", title: "点击刷新验证码" });
  const rememberBox = el("input", { type: "checkbox", id: "remember" });
  let capToken = "";

  async function refreshCaptcha() {
    capToken = String(Date.now());
    try {
      const url = await api.dataUrl("backend/api/captcha.php", { r: capToken });
      clear(capImg).append(el("img", { src: url, alt: "验证码" }));
    } catch (e) {
      toastErr("验证码获取失败：" + e.message);
      clear(capImg).append(el("span", { style: "font-size:var(--fs-tiny);color:var(--text-3)" }, "点击重试"));
    }
  }
  capImg.addEventListener("click", refreshCaptcha);
  refreshCaptcha();

  async function doLogin() {
    const btn = card.querySelector(".btn.primary");
    btn.disabled = true;
    btn.textContent = "登 录 中 …";
    try {
      const env = await api.post("backend/api/auth.php", {
        action: "login",
        username: username.input.value.trim(),
        password: password.input.value,
        captcha: captcha.input.value.trim(),
        remember_me: rememberBox.checked ? "on" : "",
      });
      const data = env.data || {};
      if (data.cookies) await api.saveCookies(data.cookies);
      const check = await api.get("backend/api/auth.php", { action: "check" });
      session.setUser((check.data && check.data.user) || { username: username.input.value, full_name: username.input.value, user_type: "student" });
      toastOk("欢迎回来");
      go("dashboard");
    } catch (e) {
      toastErr(e.message || "登录失败");
      refreshCaptcha();
      captcha.input.value = "";
      captcha.classList.remove("filled");
    } finally {
      btn.disabled = false;
      btn.textContent = "登 录";
    }
  }
  password.input.addEventListener("keydown", (e) => e.key === "Enter" && doLogin());
  captcha.input.addEventListener("keydown", (e) => e.key === "Enter" && doLogin());

  card.append(
    el("h2", {}, "登录账号"),
    el("p", { class: "lead" }, "使用你的途变账号登录"),
    el("div", { class: "fields" },
      username,
      password,
      el("div", { class: "captcha-row" }, captcha, capImg)
    ),
    el("label", { style: "display:flex;gap:8px;align-items:center;margin-top:14px;font-size:var(--fs-small);color:var(--text-2);cursor:pointer" },
      rememberBox, "记住我（30 天内自动登录）"),
    el("button", { class: "btn primary", onclick: doLogin }, "登 录"),
    el("div", { class: "auth-foot" },
      "还没有账号？", el("a", { href: "#/register" }, "立即注册"),
      el("span", { style: "opacity:0.4" }, " · "),
      el("a", { href: "#/forgot" }, "忘记密码")
    )
  );
  return card;
}

function registerCard() {
  const card = el("div", { class: "auth-card" });
  const f = {
    username: field("用户名", ""),
    email: field("邮箱", ""),
    fullName: field("真实姓名（可选）", ""),
    password: field("密码（至少 6 位）", "", { type: "password" }),
    confirm: field("确认密码", "", { type: "password" }),
    code: field("邮箱验证码", ""),
  };
  let sending = false;
  async function sendCode() {
    if (sending) return;
    const email = f.email.input.value.trim();
    if (!email.includes("@")) return toastErr("请先填写正确的邮箱");
    sending = true;
    try {
      const env = await api.post("backend/api/auth.php", { action: "send_verification_code", email });
      toastOk(env.message || "验证码已发送至邮箱");
      cooldown(btnCode);
    } catch (e) {
      toastErr(e.message);
    } finally { sending = false; }
  }
  const btnCode = el("button", { class: "btn sm", onclick: sendCode }, "发送验证码");

  async function doRegister() {
    try {
      if (f.password.input.value !== f.confirm.input.value) throw new Error("两次输入的密码不一致");
      const env = await api.post("backend/api/auth.php", {
        action: "register",
        username: f.username.input.value.trim(),
        email: f.email.input.value.trim(),
        full_name: f.fullName.input.value.trim(),
        password: f.password.input.value,
        confirm_password: f.confirm.input.value,
        verification_code: f.code.input.value.trim(),
      });
      toastOk(env.message || "注册成功，请登录");
      go("login");
    } catch (e) { toastErr(e.message); }
  }

  card.append(
    el("h2", {}, "创建账号"),
    el("p", { class: "lead" }, "注册后即可参加考试与练习"),
    el("div", { class: "fields" },
      f.username, f.email, f.fullName, f.password, f.confirm,
      el("div", { class: "captcha-row" }, f.code, btnCode)
    ),
    el("button", { class: "btn primary", onclick: doRegister }, "注 册"),
    el("div", { class: "auth-foot" }, "已有账号？", el("a", { href: "#/login" }, "直接登录"))
  );
  return card;
}

function cooldown(btn, sec = 60) {
  let left = sec;
  btn.disabled = true;
  const t = setInterval(() => {
    left -= 1;
    btn.textContent = `${left}s`;
    if (left <= 0) { clearInterval(t); btn.disabled = false; btn.textContent = "发送验证码"; }
  }, 1000);
}

function forgotCard() {
  const card = el("div", { class: "auth-card" });
  const email = field("注册邮箱", "");
  const code = field("重置码", "");
  const newPass = field("新密码（至少 6 位）", "", { type: "password" });
  const confirm = field("确认新密码", "", { type: "password" });

  const btnCode = el("button", { class: "btn sm", onclick: async () => {
    try {
      const env = await api.post("backend/api/auth.php", { action: "send_reset_code", email: email.input.value.trim() });
      toastOk(env.message || "重置码已发送");
      cooldown(btnCode);
    } catch (e) { toastErr(e.message); }
  } }, "发送重置码");

  async function doReset() {
    try {
      if (newPass.input.value !== confirm.input.value) throw new Error("两次输入的密码不一致");
      const env = await api.post("backend/api/auth.php", {
        action: "reset_password",
        email: email.input.value.trim(),
        reset_code: code.input.value.trim(),
        new_password: newPass.input.value,
        confirm_password: confirm.input.value,
      });
      toastOk(env.message || "密码已重置，请用新密码登录");
      go("login");
    } catch (e) { toastErr(e.message); }
  }

  card.append(
    el("h2", {}, "找回密码"),
    el("p", { class: "lead" }, "通过注册邮箱接收重置码"),
    el("div", { class: "fields" },
      email,
      el("div", { class: "captcha-row" }, code, btnCode),
      newPass, confirm
    ),
    el("button", { class: "btn primary", onclick: doReset }, "重置密码"),
    el("div", { class: "auth-foot" }, el("a", { href: "#/login" }, "返回登录"))
  );
  return card;
}

export function renderAuth(container, param) {
  const page = param === "register"
    ? authShell(registerCard())
    : param === "forgot"
      ? authShell(forgotCard())
      : authShell(loginCard());
  container.append(page);
}
