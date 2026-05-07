const navLinks = [...document.querySelectorAll(".site-nav a")];
const copyButton = document.querySelector(".copy-button");

const sections = navLinks
  .map((link) => document.querySelector(link.getAttribute("href")))
  .filter(Boolean);

function updateActiveLink() {
  const current = sections
    .filter((section) => section.getBoundingClientRect().top < 160)
    .at(-1);

  navLinks.forEach((link) => {
    link.classList.toggle("active", current && link.getAttribute("href") === `#${current.id}`);
  });
}

window.addEventListener("scroll", updateActiveLink, { passive: true });
updateActiveLink();

copyButton?.addEventListener("click", async () => {
  const text = copyButton.dataset.copy;

  try {
    await navigator.clipboard.writeText(text);
    copyButton.textContent = "已复制";
  } catch {
    copyButton.textContent = "复制失败";
  }

  window.setTimeout(() => {
    copyButton.textContent = "复制";
  }, 1600);
});
