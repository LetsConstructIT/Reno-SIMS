function CardComponent({ title, children }: { title: string; children: any }) {
  return (
    <div className="border-2 border-sky-500 rounded-xl mb-4 p-2">
      <p className="text-lg font-medium">{title}</p>
      {children}
    </div>
  );
}

export default CardComponent;
