let sayi = 0;
document.getElementById("btn").addEventListener("click", () => {
  sayi++;
  document.getElementById("sayac").textContent = "Tıklama: " + sayi;
});